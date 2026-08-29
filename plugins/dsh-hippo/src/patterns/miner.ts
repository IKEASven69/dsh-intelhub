/**
 * 跨会话工具序列挖掘（SOP 候选）—— hippo patterns.py 的 TS 移植。
 *
 * 流水线：transcripts → 每会话 ToolEvent 序列 → 归一化签名
 *        → n-gram 计数 → 跨会话过滤 → 包含去重 → 质量评分 → 排序
 *
 * 纯启发式，只读，不写库。与 Python 版算法逐行等价。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { entryToTurns, parseJsonl, type Turn } from './transcript.js';

// ── 调参 ──────────────────────────────────────────
export const MIN_N = 2; // 值得报告的最短工作流
export const MAX_N = 4; // 更长的链很少能泛化
export const RECENCY_HALF_LIFE_DAYS = 30.0; // 程序性知识衰减更快
export const MAX_EXAMPLES = 3; // 每个模式保留的原始步骤摘要数

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ── 1. 工具事件 ───────────────────────────────────

/** 一次工具调用及其结果，归一化后用于序列挖掘 */
export interface ToolEvent {
  toolName: string;
  signature: string; // 泛化形式，如 "Bash(git)" / "Edit(.py)"
  failed: boolean;
  ts: number; // epoch 秒；transcript 无时间戳时为 0
  summary: string; // 原始一行摘要（如真实命令），用于 examples
}

/**
 * 泛化一次工具调用，让"同类步骤"跨会话匹配。
 * 精确参数从不重复（文件路径、命令各异），签名只保留有区分度的部分：
 * shell 命令取动词，文件工具取扩展名。
 */
export function signature(toolName: string, text: string): string {
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    let rest = text.trim();
    let head = rest ? rest.split(/\s+/, 2)[0] : '';
    // 剥掉常见 env-var 前缀："FOO=1 pytest" 签为 pytest
    while (head.includes('=') && !head.startsWith('./') && !head.startsWith('/')) {
      const parts = rest.split(/\s+/);
      if (parts.length < 2) break;
      rest = parts.slice(1).join(' ');
      head = rest.split(/\s+/, 2)[0];
    }
    // ./scripts/x.sh 和 x.sh 签成一样（同时处理 / 和 \，Windows 兼容）
    head = head.split(/[\\/]/).filter(s => s).pop() ?? head;
    return head ? `${toolName}(${head})` : toolName;
  }
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    const m = /\.\w+/.exec(text);
    return m ? `${toolName}(${m[0]})` : toolName;
  }
  // Grep/Glob/Task 等：参数差异太大，不做泛化
  return toolName;
}

/** ISO-8601 → epoch 秒；异常输入返回 0（对应 Python _parse_ts） */
function parseTs(ts: string): number {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms / 1000;
}

/**
 * 把 tool_use turn 与其后的 tool_result turn 配对成 ToolEvent。
 * Claude transcript 中 assistant 的 tool_use block 与下一条 user 消息的
 * tool_result block 顺序一致，用 FIFO 队列配对。没有等到结果的 tool_use
 * （会话中断）保持 failed=false —— 没有结果不等于失败。
 */
export function eventsFromTurns(turns: Turn[]): ToolEvent[] {
  const events: ToolEvent[] = [];
  const pending: ToolEvent[] = [];
  for (const t of turns) {
    if (t.toolName) {
      const ev: ToolEvent = {
        toolName: t.toolName,
        signature: signature(t.toolName, t.text),
        failed: false,
        ts: parseTs(t.ts),
        summary: t.text.slice(0, 120),
      };
      events.push(ev);
      pending.push(ev);
    } else if (t.role === 'tool' && pending.length) {
      pending.shift()!.failed = t.toolFailed;
    }
  }
  return events;
}

// ── 2. transcript 发现与加载 ───────────────────────

/** Claude projects 目录下所有 .jsonl，新的在前。limit>0 时截取前 N 个 */
export function findTranscripts(baseDir?: string, limit = 0): string[] {
  const base = baseDir ?? CLAUDE_PROJECTS_DIR;
  if (!fs.existsSync(base)) return [];
  const files: { p: string; mtime: number }[] = [];
  for (const proj of fs.readdirSync(base, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(base, proj.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      files.push({ p, mtime: fs.statSync(p).mtimeMs / 1000 });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const all = files.map(f => f.p);
  return limit > 0 ? all.slice(0, limit) : all;
}

/** 解析一个 transcript 文件为工具事件序列 */
export function loadSessionEvents(filePath: string): ToolEvent[] {
  const turns: Turn[] = [];
  const text = fs.readFileSync(filePath, 'utf-8');
  for (const entry of parseJsonl(text)) {
    turns.push(...entryToTurns(entry));
  }
  const events = eventsFromTurns(turns);
  // 没有时间戳时用文件 mtime 填充，保证 recency 评分可用
  if (events.length && !events.some(e => e.ts)) {
    const mtime = fs.statSync(filePath).mtimeMs / 1000;
    for (const e of events) e.ts = mtime;
  }
  return events;
}

// ── 3. 挖掘 ───────────────────────────────────────

/** 跨会话重复出现的工作流（SOP 候选） */
export interface Pattern {
  steps: string[]; // 归一化签名，按序
  count: number; // 全会话总出现次数
  sessions: Set<string>; // 去重后的会话 id
  failures: number; // 含至少一个失败步骤的出现次数
  lastSeen: number; // 最近一次出现（epoch）
  examples: string[][]; // 原始步骤摘要
  score: number; // scorePatterns() 填充
}

export function makePattern(steps: string[]): Pattern {
  return { steps, count: 0, sessions: new Set(), failures: 0, lastSeen: 0, examples: [], score: 0 };
}

export function successRate(p: Pattern): number {
  return p.count ? 1.0 - p.failures / p.count : 0.0;
}

export function patternToDict(p: Pattern): Record<string, unknown> {
  return {
    steps: p.steps,
    count: p.count,
    sessions: p.sessions.size,
    success_rate: Math.round(successRate(p) * 1000) / 1000,
    last_seen: Math.round(p.lastSeen * 10) / 10,
    score: Math.round(p.score * 10000) / 10000,
    examples: p.examples,
  };
}

function isContiguousSubseq(short: string[], long: string[]): boolean {
  const n = short.length, m = long.length;
  for (let i = 0; i <= m - n; i++) {
    if (long.slice(i, i + n).every((s, j) => s === short[j])) return true;
  }
  return false;
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * 跨会话统计工具签名 n-gram 并过滤。
 * 模式必须同时满足 min_count 总次数 + min_sessions 个不同会话 ——
 * 单个马拉松会话刷不出"重复工作流"。
 */
export function minePatterns(
  sessions: Map<string, ToolEvent[]>,
  opts: { minSessions?: number; minCount?: number; minN?: number; maxN?: number } = {},
): Pattern[] {
  const { minSessions = 2, minCount = 3, minN = MIN_N, maxN = MAX_N } = opts;

  const found = new Map<string, Pattern>();
  for (const [sid, events] of sessions) {
    const sigs = events.map(e => e.signature);
    for (let n = minN; n <= maxN; n++) {
      for (let i = 0; i <= sigs.length - n; i++) {
        const keySteps = sigs.slice(i, i + n);
        const key = keySteps.join('');
        let pat = found.get(key);
        if (!pat) {
          pat = makePattern(keySteps);
          found.set(key, pat);
        }
        pat.count += 1;
        pat.sessions.add(sid);
        const window = events.slice(i, i + n);
        if (window.some(e => e.failed)) pat.failures += 1;
        const ts = Math.max(0, ...window.map(e => e.ts));
        pat.lastSeen = Math.max(pat.lastSeen, ts);
        if (pat.examples.length < MAX_EXAMPLES) {
          pat.examples.push(window.map(e => e.summary));
        }
      }
    }
  }

  let survivors = [...found.values()].filter(
    p => p.count >= minCount && p.sessions.size >= minSessions,
  );

  // 自环（"Grep → Grep → Grep"）是重复不是工作流，丢弃
  survivors = survivors.filter(p => new Set(p.steps).size > 1);

  // 包含去重：只在更长存活模式内部出现（支撑完全相同）的短模式丢弃
  const longer = survivors.filter(p => p.steps.length > minN);
  return survivors.filter(p => !longer.some(q =>
    q.steps.length > p.steps.length
    && q.count === p.count
    && isSubset(p.sessions, q.sessions)
    && isContiguousSubseq(p.steps, q.steps),
  ));
}

/**
 * 按 支撑度 × 广度 × 可靠度 × 新近度 排序。
 * - support: log 缩放的出现次数
 * - breadth: 不同会话数加权，跨项目习惯加分
 * - reliability: 0.5 + 0.5 × 成功率 —— 经常失败的模式保留部分分数
 * - recency: 指数衰减（30 天半衰期），权重下限 60%
 */
export function scorePatterns(patterns: Pattern[], now?: number): Pattern[] {
  const nowTs = now ?? Date.now() / 1000;
  const out = [...patterns];
  for (const p of out) {
    const support = Math.log1p(p.count);
    const breadth = 1.0 + 0.25 * (p.sessions.size - 1);
    const reliability = 0.5 + 0.5 * successRate(p);
    const ageDays = p.lastSeen ? Math.max(0, (nowTs - p.lastSeen) / 86400.0) : 365.0;
    const recency = Math.exp((-ageDays * Math.LN2) / RECENCY_HALF_LIFE_DAYS);
    p.score = support * breadth * reliability * (0.6 + 0.4 * recency);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ── 4. 渲染 ───────────────────────────────────────

/** 人类可读的 SOP 草图（CLI 审查用） */
export function renderPattern(p: Pattern): string {
  const lines = [
    `score=${p.score.toFixed(2)}  seen ${p.count}x in ${p.sessions.size} sessions, ` +
    `success ${(successRate(p) * 100).toFixed(0)}%`,
    '  steps: ' + p.steps.join(' → '),
  ];
  if (p.examples.length) {
    lines.push('  e.g.:  ' + p.examples[0].map(s => s || '?').join(' | '));
  }
  return lines.join('\n');
}
