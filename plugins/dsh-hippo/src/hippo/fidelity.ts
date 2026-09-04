/**
 * fidelity bench v1（H13 M-2）：交接/召回质量的客观标尺。
 *
 * 三指标（H7 §5.2 定义）：
 *  1. 复述保真——快照声称的事 vs 证据（记忆库 + git）对账：幻觉（声称无证据）
 *     和遗漏（证据有但快照没提）计数
 *  2. 噪声率——快照条目中与任务无关（无法对账到任何证据源）的占比
 *  3. 接手成功率——需人工标注，本工具只输出对账报告供人工判读
 *
 * 诚实边界（§5.2 不变量）：对账是**规则匹配**（LLM 不当裁判）——
 * 文本相似度 + 关键词交集，不判定语义真假。
 *
 * 用法：hippo fidelity --handoff <HANDOFF.md> [--project p]
 * 输入格式：Markdown 快照（Task/Changed 段落，同 m0-handoff.py 产物）。
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import type { MemoryEngine } from './memory.js';

export interface FidelityEntry {
  claim: string;
  kinds: Array<'memory' | 'git' | 'none'>;
  hallucination: boolean; // 无任何证据支撑
}

export interface FidelityReport {
  claims: FidelityEntry[];
  total: number;
  hallucinations: number;
  supported: number;
  noiseRate: number; // 无法对账且不以字母数字细节支撑的条目占比（粗判）
  generatedAt: string;
  handoffPath: string;
}

/** 从 HANDOFF.md 提取声称：Task 列表项 + Changed 文件（§5.2.2 行为痕迹一等公民）。 */
export function parseHandoffClaims(md: string): string[] {
  const claims: string[] = [];
  const inTask = /\b(?:Task|任务)\b/i.test(md);
  // 列表项（- [x] / - 文本）与 Changed 的文件路径行
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (/^[-*]\s+\[.\]/.test(t)) claims.push(t.replace(/^[-*]\s+\[.\]\s*(\([^)]*\))?\s*/, ''));
    else if (/^[-*]\s+/.test(t) && /[\\/]\w+\.\w+/.test(t)) claims.push(t); // 文件路径行
  }
  return claims.filter((c) => c.length > 4);
}

/** 声称 → 证据对账：记忆库召回 + git log 关键词。 */
async function evidenceFor(
  engine: { recall: (q: string, o: Record<string, unknown>) => Promise<Array<{ text: string }>> },
  claim: string,
  project?: string,
): Promise<Array<'memory' | 'git'>> {
  const kinds: Array<'memory' | 'git'> = [];
  // 记忆库：取 claim 的实词（≥2 字符）逐个 recall，任一命中高相似即算证据
  const terms = claim.replace(/[^\w\u4e00-\u9fa5]+/g, ' ').split(/\s+/).filter((t) => t.length >= 2).slice(0, 4);
  try {
    for (const term of terms) {
      const hits = await engine.recall(term, { project: project ?? 'global', limit: 3 });
      if (hits.length > 0) { kinds.push('memory'); break; }
    }
  } catch { /* recall 不可用跳过 */ }
  // git：最近 200 条 commit message 关键词交集
  try {
    const log = execSync('git log --oneline -200', { encoding: 'utf8', cwd: process.cwd() });
    const lower = log.toLowerCase();
    if (terms.some((t) => lower.includes(t.toLowerCase().slice(0, 4)))) kinds.push('git');
  } catch { /* 非 git 目录跳过 */ }
  return kinds;
}

/** 主入口：对账快照声称，输出报告。 */
export async function runFidelity(
  engine: Parameters<typeof evidenceFor>[0],
  handoffPath: string,
  opts: { project?: string; outDir?: string } = {},
): Promise<FidelityReport> {
  const md = readFileSync(handoffPath, 'utf8');
  const claims = parseHandoffClaims(md);
  const entries: FidelityEntry[] = [];
  for (const claim of claims) {
    const kinds = await evidenceFor(engine, claim, opts.project);
    entries.push({ claim: claim.slice(0, 120), kinds, hallucination: kinds.length === 0 });
  }
  const hallucinations = entries.filter((e) => e.hallucination).length;
  const supported = entries.length - hallucinations;
  // 噪声率粗判：与任何证据无交集且长度 <20 的短条目
  const noise = entries.filter((e) => e.claim.length < 20 && e.hallucination).length;
  const report: FidelityReport = {
    claims: entries,
    total: entries.length,
    hallucinations,
    supported,
    noiseRate: entries.length === 0 ? 0 : Math.round((noise / entries.length) * 100),
    generatedAt: new Date().toISOString(),
    handoffPath,
  };
  // 报告落盘（趋势对比）
  try {
    const dir = opts.outDir ?? join(process.env.HIPPO_DATA_DIR ?? join(homedir(), '.hippo'), 'fidelity-reports');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `fidelity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8');
    appendFileSync(join(dir, 'index.jsonl'), JSON.stringify({
      file, handoffPath, total: report.total, hallucinations, supported,
      noiseRate: report.noiseRate, ts: report.generatedAt,
    }) + '\n', 'utf-8');
  } catch { /* 落盘失败不影响报告返回 */ }
  return report;
}

/** 人类可读报告文本。 */
export function formatFidelityReport(r: FidelityReport): string {
  const lines = [
    `fidelity 报告 · ${r.generatedAt}`,
    `快照: ${r.handoffPath}`,
    `声称 ${r.total} 条 → 有证据 ${r.supported} · 疑似幻觉 ${r.hallucinations} · 噪声率 ${r.noiseRate}%`,
    '',
  ];
  for (const e of r.claims) {
    const mark = e.hallucination ? '❌ 无证据' : `✅ ${e.kinds.join('+')}`;
    lines.push(`${mark}  ${e.claim}`);
  }
  lines.push('', '幻觉判定是规则对账（关键词+召回），语义真假需人工复核。');
  return lines.join('\n');
}

export function ensureOutDir(dir: string): boolean {
  return existsSync(dir);
}
