/**
 * 睡眠整合（P0-3）：记忆库自我维护，防膨胀。保守原则——只做确定安全的事，
 * 可疑的只出报告不动手。
 *
 * 1. 近重复合并：同项目内 sim ≥ 0.95 的簇（入库去重漏网的边缘对，如手工
 *    重复写入/跨 agent 复读）——apply 时合并为一行：保强者、强度相加、弱者删除。
 * 2. 孤儿 L0 源清理：sources/*.json 不被任何记忆引用 → 删（磁盘回收）。
 * 3. 过期搁置清理：shelved.jsonl 里超过 30 天的候选 → 丢。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryEngine, MemoryRecord } from './memory.js';
import { listShelved, takeShelved } from './auto-distill.js';
import { appPath } from '../core/paths.js';

export interface DupCluster {
  keep: { id: string; text: string; strength: number };
  drop: { id: string; text: string; strength: number }[];
  similarity: number;
}

export interface SleepReport {
  dupClusters: DupCluster[];
  merged: number;
  orphanSources: string[];
  orphanSourcesDeleted: number;
  staleShelvedDropped: number;
}

const MERGE_SIM = 0.95;
const STALE_SHELVED_DAYS = 30;

export async function runSleep(engine: MemoryEngine, opts: { apply?: boolean } = {}): Promise<SleepReport> {
  const { apply = false } = opts;
  const report: SleepReport = { dupClusters: [], merged: 0, orphanSources: [], orphanSourcesDeleted: 0, staleShelvedDropped: 0 };

  // ── 1. 近重复簇（按 id 去重避免 A~B、B~A 重复报告）──
  const seenPair = new Set<string>();
  const dropped = new Set<string>();
  const all = (engine.store as unknown as { scan(): [MemoryRecord, number][] }).scan().map(([r]) => r);
  for (const m of all) {
    if (dropped.has(m.id) || m.superseded_by) continue; // 已被取代的不参与合并
    let sims: { id: string; similarity: number }[] = [];
    try { sims = await engine.similar(m.id, { limit: 5 }); } catch { continue; }
    // similar() 只回 id/similarity——文本与强度从全量记录补
    const byId = new Map(all.map(r => [r.id, r]));
    const near = sims
      .filter(s => s.similarity >= MERGE_SIM && s.id !== m.id && !dropped.has(s.id) && !byId.get(s.id)?.superseded_by)
      .map(s => ({ id: s.id, text: byId.get(s.id)?.text ?? '', strength: byId.get(s.id)?.strength ?? 1, similarity: s.similarity }));
    if (near.length === 0) continue;
    const pairKey = [m.id, ...near.map(n => n.id)].sort().join('|');
    if (seenPair.has(pairKey)) continue;
    seenPair.add(pairKey);
    // 强者为 keep（同强度取先者）
    const family = [{ id: m.id, text: m.text, strength: m.strength ?? 1 }, ...near.map(n => ({ id: n.id, text: n.text, strength: n.strength ?? 1 }))];
    family.sort((a, b) => b.strength - a.strength);
    const keep = family[0];
    const dropList = family.slice(1);
    report.dupClusters.push({ keep, drop: dropList, similarity: near[0].similarity });

    if (apply) {
      const gain = dropList.reduce((s, d) => s + (d.strength ?? 1), 0);
      try {
        await engine.store.touch(keep.id, { accessedAt: Date.now() / 1000, strength: (keep.strength ?? 1) + gain });
        for (const d of dropList) { await engine.forget(d.id); dropped.add(d.id); }
        report.merged += dropList.length;
      } catch { /* 单簇失败不拖垮整轮 */ }
    }
  }

  // ── 2. 孤儿 L0 源 ──
  const usedSources = new Set(all.filter(m => !dropped.has(m.id)).map(m => m.source_id).filter(Boolean));
  // 搁置候选也持 source 引用（待复核后可回放/重蒸馏），同样算在用
  for (const sh of listShelved()) if (sh.sourceId) usedSources.add(sh.sourceId);
  const sourcesDir = appPath('sources');
  try {
    for (const name of fs.readdirSync(sourcesDir)) {
      if (!name.endsWith('.json')) continue;
      const sid = name.replace(/\.json$/, '');
      if (!usedSources.has(sid)) {
        report.orphanSources.push(sid);
        if (apply) {
          // 移入 trash 而非直接删（保险：误判可捞回；trash 目录随用户自行清理）
          try {
            const trashDir = path.join(path.dirname(sourcesDir), 'sources.trash');
            fs.mkdirSync(trashDir, { recursive: true });
            fs.renameSync(path.join(sourcesDir, name), path.join(trashDir, name));
            report.orphanSourcesDeleted += 1;
          } catch { /* 尽力 */ }
        }
      }
    }
  } catch { /* sources 目录不存在 */ }

  // ── 3. 过期搁置 ──
  const cutoff = Date.now() / 1000 - STALE_SHELVED_DAYS * 86400;
  const stale = listShelved().map((s, i) => ({ i, s })).filter(({ s }) => s.createdAt < cutoff);
  if (stale.length > 0) {
    report.staleShelvedDropped = stale.length;
    if (apply) takeShelved(stale.map(x => x.i));
  }

  return report;
}
