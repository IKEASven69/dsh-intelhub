/**
 * 待审队列 LLM 预审（H9-②）：治理自动化——50+ 条积压没人 review 就是
 * "自动堆放的垃圾场"前兆。本模块批量给 shelved 候选打 LLM 建议
 * （accept/discard + 一句理由），人只做最终确认（GUI 勾选照旧，建议仅辅助）。
 *
 * 关键不变量（对齐 §5.2.1）：LLM 只提建议，**不直接动队列**——accept/discard
 * 的执行权永远在人（或显式调用 apply/discard 端点的人）手里。
 *
 * 预审状态存进条目本身（suggest 字段），重复预审覆盖旧建议。
 * LLM 不可用 → 返回 { reviewed: 0 }，队列原样（预审是增强不是依赖）。
 */
import { listShelved, saveShelvedItems, type ShelvedCandidate } from './auto-distill.js';

export type CompleteFn = (system: string, user: string) => Promise<string>;

export interface ReviewStats { reviewed: number; accept: number; discard: number; failed?: boolean }

const SYSTEM = `你是记忆库的预审员。对每条从 AI 编程会话蒸馏的"待审记忆候选"，给出入库建议。
入库标准：未来新会话里，这条信息能让 agent 做得更好或避免踩坑。
丢弃：过程自语、调查中间态、无上下文的碎片、闲聊、样板文、与项目无关。
保留：具体决策、根因教训、用户偏好、技术事实。
只输出 JSON 数组：[{"i":行号,"k":true,"r":"十 confirming字内理由"}]，r=建议理由（k=false 时给丢弃理由）。`;

/** 批量预审：每批 15 条，写回 suggest 字段。complete 抛错即整体放弃（返回 failed）。 */
export async function reviewShelved(complete: CompleteFn, opts: { batch?: number } = {}): Promise<ReviewStats> {
  const items = listShelved();
  if (items.length === 0) return { reviewed: 0, accept: 0, discard: 0 };
  const batch = opts.batch ?? 15;
  let accept = 0;
  let discard = 0;
  let reviewed = 0;
  for (let start = 0; start < items.length; start += batch) {
    const slice = items.slice(start, start + batch);
    const numbered = slice
      .map((it, i) => `${i + 1}. [${it.candidate.type}] ${it.candidate.text.slice(0, 120).replace(/\n/g, ' ')}`)
      .join('\n');
    let raw: string;
    try {
      raw = await complete(SYSTEM, numbered);
    } catch {
      return { reviewed, accept, discard, failed: true };
    }
    // 解析（与 refine.ts 同策略：剥 think 块、容错围栏）
    const lastThink = raw.lastIndexOf('</think>');
    const clean = lastThink >= 0 ? raw.slice(lastThink + 8) : raw;
    const s = clean.indexOf('[');
    const e = clean.lastIndexOf(']');
    if (s === -1 || e <= s) continue;
    let arr: unknown;
    try { arr = JSON.parse(clean.slice(s, e + 1)); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const v of arr) {
      if (typeof v !== 'object' || v === null) continue;
      const { i, k, r } = v as Record<string, unknown>;
      if (typeof i !== 'number' || typeof k !== 'boolean') continue;
      const idx = start + i - 1; // 行号 1 基
      if (idx < 0 || idx >= items.length) continue;
      (items[idx] as ShelvedCandidate & { suggest?: string; suggestReason?: string }).suggest = k ? 'accept' : 'discard';
      (items[idx] as ShelvedCandidate & { suggest?: string; suggestReason?: string }).suggestReason =
        typeof r === 'string' ? r.slice(0, 60) : '';
      reviewed++;
      if (k) accept++; else discard++;
    }
  }
  if (reviewed > 0) saveShelvedItems(items);
  return { reviewed, accept, discard };
}
