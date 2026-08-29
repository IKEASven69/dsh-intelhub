/**
 * Skill 线阶段一（纯规则，零 LLM）：从 L0 溯源提取"修正模式"。
 *
 * 核心洞察（来自 claude-code-self-distill 调研）：
 * "从会话蒸馏的 skill 包含我实际做了什么——包括错误和修正"
 * 推理链 = 问题 → 尝试 A（失败）→ 修正为 B（成功）→ SOP
 *
 * 我们的优势：L0 Turn 流已有 toolFailed 标记——失败的工具调用后面紧跟
 * 一个成功的调用，就是一次"修正"。不需要 LLM，不需要嵌入，纯结构扫描。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { decompress as fzstdDecompress } from 'fzstd';

export interface CorrectionPattern {
  /** 触发条件：什么操作失败了 */
  failedTool: string;
  failedText: string;
  /** 修正动作：紧接着做了什么成功了 */
  fixTool: string;
  fixText: string;
  /** 产出 SOP 候选文本 */
  sop: string;
  /** 来源会话 */
  sessionId: string;
  at: number;
}

export interface SkillExtractReport {
  sessionsScanned: number;
  corrections: CorrectionPattern[];
  /** 按修正模式聚合的 SOP 候选（去重） */
  sopCandidates: Array<{ text: string; occurrences: number; sample: CorrectionPattern }>;
}

const SESSIONS_ROOT = path.join(homedir(), '.dsh', 'sessions');

interface TurnRecord {
  type: string;
  time?: number;
  data?: {
    turn?: number;
    step?: number;
    callId?: string;
    name?: string;
    arguments?: string;
    message?: { content?: Array<{ type: string; text?: string }> };
  };
}

function decodeLog(file: string): string {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.zstd')) {
    return new TextDecoder().decode(fzstdDecompress(new Uint8Array(buf)));
  }
  return buf.toString('utf8');
}

/** 工具调用的参数摘要（截前 100 字） */
function argSummary(args: string | undefined): string {
  if (!args) return '';
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    // 常见字段：command / file_path / pattern / query
    for (const key of ['command', 'file_path', 'pattern', 'query', 'path', 'url']) {
      if (typeof obj[key] === 'string') return String(obj[key]).slice(0, 100);
    }
    return JSON.stringify(obj).slice(0, 100);
  } catch {
    return args.slice(0, 100);
  }
}

/** 从工具事件流中提取"失败→修正"对。
 * 模式：tool/call(失败) → tool/call(成功) 或 tool/call(失败) → assistant/text(修正说明) */
function extractCorrections(turns: TurnRecord[], sessionId: string): CorrectionPattern[] {
  const out: CorrectionPattern[] = [];
  const toolCalls: Array<{ name: string; args: string; failed: boolean; at: number; text: string }> = [];

  for (const t of turns) {
    if (t.type === 'tool/call' && t.data?.name) {
      toolCalls.push({
        name: t.data.name,
        args: argSummary(t.data.arguments),
        failed: false,
        at: t.time ?? 0,
        text: '',
      });
    } else if (t.type === 'tool/result') {
      // 找最近的 tool/call 并标记成败
      // tool/result 的 data 里 is_error 标记失败
      const lastCall = toolCalls[toolCalls.length - 1];
      if (lastCall && t.data) {
        const raw = JSON.stringify(t.data);
        lastCall.failed = raw.includes('"is_error":true') || raw.includes('"error"');
        if (lastCall.failed) {
          lastCall.text = raw.slice(0, 150);
        }
      }
    }
  }

  // 扫描连续对：失败 → 成功
  for (let i = 0; i < toolCalls.length - 1; i++) {
    const failed = toolCalls[i];
    const next = toolCalls[i + 1];
    if (!failed.failed || next.failed) continue;

    // 同一步骤内的修正（不是跨步骤的新尝试）
    const timeDiff = Math.abs(next.at - failed.at);
    if (timeDiff > 300_000) continue; // >5 分钟不算修正

    const sop = `当遇到 ${failed.name} 失败（${failed.args.slice(0, 60)}）时，改用 ${next.name}（${next.args.slice(0, 60)}）——后者成功`;
    out.push({
      failedTool: failed.name,
      failedText: failed.args,
      fixTool: next.name,
      fixText: next.args,
      sop,
      sessionId,
      at: failed.at,
    });
  }

  return out;
}

/** 扫描全部 dsh 会话日志，提取修正模式并聚合为 SOP 候选。 */
export function extractSkillCandidates(): SkillExtractReport {
  const report: SkillExtractReport = { sessionsScanned: 0, corrections: [], sopCandidates: [] };

  if (!fs.existsSync(SESSIONS_ROOT)) return report;

  const projDirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(SESSIONS_ROOT, d.name));

  const bySopText = new Map<string, { occurrences: number; sample: CorrectionPattern }>();

  for (const projDir of projDirs) {
    const sessionDirs = fs.readdirSync(projDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(projDir, d.name));

    for (const sessionDir of sessionDirs) {
      const file = path.join(sessionDir, 'session.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      report.sessionsScanned += 1;

      try {
        const text = decodeLog(file);
        const turns: TurnRecord[] = text.split('\n')
          .filter(l => l.trim() !== '')
          .map(l => { try { return JSON.parse(l) as TurnRecord; } catch { return null; } })
          .filter((t): t is TurnRecord => t !== null);

        const corrections = extractCorrections(turns, sessionDir.split(/[\\/]/).pop() ?? '');
        report.corrections.push(...corrections);

        // 聚合（按 failedTool+fixTool 对去重）
        for (const c of corrections) {
          const key = `${c.failedTool}→${c.fixTool}`;
          const existing = bySopText.get(key);
          if (existing) {
            existing.occurrences += 1;
          } else {
            bySopText.set(key, { occurrences: 1, sample: c });
          }
        }
      } catch {
        // 单会话失败不拖垮
      }
    }
  }

  report.sopCandidates = [...bySopText.entries()]
    .sort((a, b) => b[1].occurrences - a[1].occurrences)
    .map(([key, v]) => ({
      text: `${v.sample.sop}（出现 ${v.occurrences} 次）`,
      occurrences: v.occurrences,
      sample: v.sample,
    }))
    .filter(c => c.occurrences >= 1); // 阶段一不设门槛，阶段二 LLM 过滤

  return report;
}
