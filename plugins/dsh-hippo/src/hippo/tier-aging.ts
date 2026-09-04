/**
 * tier 老化归档（H12 M-01）：上下文越积越大的长期答案。
 *
 * 机制（ACP tier-1/2/3 借鉴落地）：fact/lesson/decision 距今 >90 天、
 * 未被取代、按 项目+月 分组 ≥3 条 → 卷成一条摘要记忆（type=lesson、
 * text 带 [归档] 前缀 + 原始条数），原始条目 markSuperseded(→摘要) 沉底
 * 可逆——recall 降权但演化链/追溯完整。preference 豁免（用户偏好不该粗化）。
 *
 * LLM 压缩走 completeFn（refinerBridge 通道），失败降级规则拼接（首句+条数）。
 * 摘要 text 恒等于 detailText 可从记忆反推分组；原始条目保留原文可恢复。
 */
import type { MemoryEngine } from './memory.js';
import { STALE_FACT_DAYS } from './memory.js';

export type TierCompleteFn = (system: string, user: string) => Promise<string>;

/** 归档候选条件：类型参与、年龄、未被取代。 */
export function isTierCandidate(r: { type: string; created_at?: number; superseded_by?: string; text?: string }, now: number, olderThanDays = STALE_FACT_DAYS): boolean {
  if (r.superseded_by) return false;
  if (r.type !== 'fact' && r.type !== 'lesson' && r.type !== 'decision') return false; // preference 豁免
  if (!r.created_at) return false;
  return (now - r.created_at) / 86400.0 > olderThanDays;
}

export interface TierGroup {
  project: string;
  month: string; // YYYY-MM
  type: string;
  ids: string[];
  texts: string[];
}

/** 分组：项目+月份+类型（月从 created_at 推）。 */
export function groupTierCandidates(records: Array<{ id: string; type: string; project: string; created_at?: number; text?: string }>, now: number, olderThanDays = STALE_FACT_DAYS): TierGroup[] {
  const groups = new Map<string, TierGroup>();
  for (const r of records) {
    if (!isTierCandidate(r, now, olderThanDays)) continue;
    const d = new Date((r.created_at ?? 0) * 1000);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const key = `${r.project}|${month}|${r.type}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { project: r.project, month, type: r.type, ids: [], texts: [] };
      groups.set(key, g);
    }
    g.ids.push(r.id);
    g.texts.push((r.text ?? '').slice(0, 200));
  }
  return [...groups.values()].filter((g) => g.ids.length >= 3); // <3 条不值得卷
}

/** 降级摘要（LLM 不可用时）：首句 + 条数统计。 */
export function fallbackDigest(texts: string[], project: string, month: string, type: string): string {
  const typeLabel = type === 'fact' ? '事实' : type === 'lesson' ? '教训' : '决策';
  const first = (texts[0] ?? '').slice(0, 120);
  return `[归档] ${project} ${month} 的 ${texts.length} 条${typeLabel}：${first}…（其余 ${texts.length - 1} 条同类要点已折叠，原文经演化链可溯）`;
}

export interface TierAgingReport {
  groupsFound: number;
  digestsCreated: number;
  archived: number; // 被 supersede 的原始条数
  llmUsed: boolean;
  failed: boolean;
}

/** LLM 压缩摘要（失败返回 null → 降级拼接）。 */
async function llmDigest(complete: TierCompleteFn, texts: string[], project: string, month: string, typeLabel: string): Promise<string | null> {
  try {
    const out = await complete(
      '把同一项目同月的多条记忆要点压缩成一段自包含的归档摘要（100 字内）。保留具体技术名词与结论，去掉重复。只输出摘要正文。',
      `项目 ${project} ${month} 的${typeLabel}记忆：\n${texts.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
    );
    const cleaned = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return cleaned === '' ? null : cleaned.slice(0, 400);
  } catch {
    return null;
  }
}

/**
 * tier 老化归档主入口。complete 抛错 → 全部降级规则拼接（骨架不丢）。
 * 返回报告供审计；dryRun 时只返回分组不落库。
 */
export async function tierAge(
  engine: MemoryEngineLike,
  complete: TierCompleteFn | null,
  opts: { apply?: boolean; olderThanDays?: number; dataDir?: string } = {},
): Promise<TierAgingReport & { groups: TierGroup[] }> {
  const now = Date.now() / 1000;
  const olderThanDays = opts.olderThanDays ?? STALE_FACT_DAYS;
  const records = (engine.store as unknown as { scan(): [MemoryRecordLite, unknown][] }).scan().map(([r]) => r);
  const groups = groupTierCandidates(records, now, olderThanDays);
  const report: TierAgingReport & { groups: TierGroup[] } = {
    groupsFound: groups.length, digestsCreated: 0, archived: 0, llmUsed: false, failed: false, groups,
  };
  if (!opts.apply || groups.length === 0) return report;

  let llmTried = false;
  for (const g of groups) {
    const typeLabel = g.type === 'fact' ? '事实' : g.type === 'lesson' ? '教训' : '决策';
    let digest: string | null = null;
    if (complete !== null) {
      llmTried = true;
      digest = await llmDigest(complete, g.texts, g.project, g.month, typeLabel);
    }
    if (digest === null) digest = fallbackDigest(g.texts, g.project, g.month, typeLabel);
    else report.llmUsed = true;

    const text = `[归档] ${g.project} ${g.month} ${typeLabel}摘要（${g.ids.length} 条原始记忆折叠于此，演化链可溯）：\n${digest}`;
    try {
      const r = await engine.remember(text, {
        type: 'lesson',
        project: g.project,
        agent: 'sleep:tier',
        createdAt: now,
      });
      if (r.status !== 'created') continue; // 撞车/被拒 → 不动原始条目
      report.digestsCreated++;
      for (const id of g.ids) {
        await engine.markSuperseded(id, r.id);
        report.archived++;
      }
    } catch {
      // 单组失败跳过，不影响其他组
    }
  }
  return report;
}

// MemoryEngine 的最小结构接口（避免循环 import 整个 memory.js 类型）
export interface MemoryEngineLike {
  remember: (text: string, opts: { type: string; project: string; agent: string; createdAt?: number }) => Promise<{ status: string; id: string }>;
  markSuperseded: (oldId: string, newId: string) => Promise<boolean>;
  store: { scan(): [MemoryRecordLite, unknown][] };
}

interface MemoryRecordLite {
  id: string;
  type: string;
  project: string;
  agent?: string;
  created_at?: number;
  accessed_at?: number;
  strength?: number;
  superseded_by?: string;
  text?: string;
}
