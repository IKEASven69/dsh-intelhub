/**
 * context_fold（H12 M-03）：会话内压缩即服务。
 *
 * agent 会话过长时，把已消费的会话区间（原文文本）交给 hippo：蒸馏成
 * 结构化记忆入库，返回摘要 + 记忆 ids + 原文指针——agent 侧即可放心
 * 丢弃原文，需要细节时 recall 反查。与 handoff 的差别：handoff 是跨
 * agent 交接（收件箱寄存），fold 是同会话瘦身（折叠已消费区间）。
 *
 * 入库走既有蒸馏管线（噪音闸门 → LLM 精炼 → 去重分档），agent:'context-fold'。
 */
import { makeTurn } from '../patterns/transcript.js';
import { extractCandidates, MAX_CANDIDATES } from './distill.js';
import type { Candidate } from './distill.js';

export interface FoldResult {
  created: number;
  reinforced: number;
  skipped: number;
  /** 入库的记忆文本（折叠后的"摘要层"） */
  folded: string[];
  /** 提示：原文在 agent 侧，hippo 只存蒸馏记忆 */
  note: string;
}

/** 文本折叠：单轮包装 → 规则抽取 → refiner（可选）→ distill。 */
export async function foldText(
  engine: {
    remember: (text: string, o: { type: string; project: string; agent: string }) => Promise<{ status: string; id: string }>;
  },
  text: string,
  opts: {
    project: string;
    refiner?: (candidates: Candidate[]) => Promise<Candidate[]>;
    max?: number;
  },
): Promise<FoldResult> {
  const clean = text.trim();
  if (clean === '') throw new Error('fold text is empty');
  const turn = makeTurn({ role: 'user', text: clean, cwd: '', ts: new Date().toISOString() });
  let candidates = extractCandidates([turn]).slice(0, opts.max ?? MAX_CANDIDATES);
  if (opts.refiner && candidates.length > 0) {
    candidates = await opts.refiner(candidates);
  }
  const folded: string[] = [];
  let created = 0, reinforced = 0, skipped = 0;
  for (const c of candidates) {
    try {
      const r = await engine.remember(c.text, { type: c.type, project: opts.project, agent: 'context-fold' });
      if (r.status === 'rejected') { skipped++; continue; }
      if (r.status === 'created') { created++; folded.push(c.text); }
      else if (r.status === 'reinforced') { reinforced++; folded.push(c.text); }
      else skipped++;
    } catch { skipped++; }
  }
  return {
    created, reinforced, skipped,
    folded,
    note: `已折叠 ${folded.length} 条要点入记忆库（新建 ${created}/强化 ${reinforced}/跳过 ${skipped}）。原文可安全丢弃——需要细节时用 memory_recall 按关键词反查。`,
  };
}
