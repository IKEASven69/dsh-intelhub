/**
 * 自动蒸馏（AD-2）：扫描器 + 一轮执行。
 *
 * 定时增量扫描（复用 discoverAll；非文件监听——五 agent 存储形态不一且有锁风险）：
 *   未蒸馏会话（不在 session_distills）且通过过滤（agent 白名单/目录黑名单/
 *   轮数下限/mtime 稳定性 ≥10min）→ 提取候选 → 按 mode 分流：
 *     review：全部进搁置队列
 *     auto：安全候选（reinforce/supersede/new≥阈值）入库，其余进队列
 *   并把该会话记入 session_distills（review 模式也记——候选已安全在队列里）。
 */
import * as fs from 'node:fs';
import { discoverAll, parseSession, loadIgnoreRules } from '../agents/index.js';
import { recordSessionDistill, distilledCountMap } from '../agents/session-index.js';
import { cwdToProject } from '../patterns/transcript.js';
import { extractCandidates, distill, type Candidate } from './distill.js';
import { saveSource } from './sources.js';
import { withEngine } from './engine-holder.js';
import {
  loadAutoSettings, saveAutoSettings, appendShelved,
  type AutoDistillSettings, type ShelvedCandidate,
  listShelved,
} from './auto-distill.js';
import { extractTasksFromTurns, mergeStoreTasks, loadStore, saveStore, collectGitContext, taskKey } from './task-context.js';
import { taskRefluxCandidates } from './task-reflux.js';

const STABLE_MS = 10 * 60 * 1000; // 会话文件 10 分钟内动过 → 还在聊，下轮再说

export interface AutoRunStats {
  scanned: number;
  created: number;
  reinforced: number;
  superseded: number;
  shelved: number;
  skipped: number;
  at: number;
}

function passesFilters(
  s: { agent: string; cwd: string; id: string; updatedAt: number },
  turns: number,
  st: AutoDistillSettings,
): boolean {
  if (st.agents.length > 0 && !st.agents.includes(s.agent)) return false;
  if (turns < st.minTurns) return false;
  if (Date.now() - s.updatedAt < STABLE_MS) return false;
  const cwdLower = s.cwd.toLowerCase();
  if (st.blockDirs.some(d => d && cwdLower.startsWith(d.toLowerCase()))) return false;
  return true;
}

// 并发护栏：启动延迟首跑与手动触发可能撞车，跑着就跳过
let _running = false;

/** 跑一轮自动蒸馏。返回统计（并写回 settings.lastRun）。 */
/** LLM 精炼注入点：插件启动时注入（走 dsh 配的模型）；不注入 = 纯规则。
 *  llmRefine 内部对 LLM 失败降级原样返回，这里无需再兜底。 */
let distillRefiner: ((candidates: import('./distill.js').Candidate[]) => Promise<import('./distill.js').Candidate[]>) | null = null
export function setDistillRefiner(refiner: typeof distillRefiner): void {
  distillRefiner = refiner
}

/** 当前注入的 LLM 精炼（未注入 = null，纯规则）。迁移入口（import.ts）共用。 */
export function getDistillRefiner(): typeof distillRefiner {
  return distillRefiner
}

export async function runAutoDistillOnce(): Promise<AutoRunStats> {
  const st = loadAutoSettings();
  const stats: AutoRunStats = { scanned: 0, created: 0, reinforced: 0, superseded: 0, shelved: 0, skipped: 0, at: Date.now() / 1000 };
  if (st.mode === 'off' || _running) return stats;
  _running = true;
  try {
    return await runOnceInner(st, stats);
  } finally {
    _running = false;
  }
}

async function runOnceInner(st: AutoDistillSettings, stats: AutoRunStats): Promise<AutoRunStats> {

  const ignore = loadIgnoreRules();

  // 未蒸馏 = 不在 session_distills 里的会话（distilledCountMap 键是 ext_id）
  const done = new Set(distilledCountMap().keys());
  const refs = discoverAll()
    .filter(s => !done.has(s.id))
    .filter(s => !ignore.isIgnored({ title: s.title, cwd: s.cwd, agent: s.agent, id: s.id }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  for (const ref of refs) {
    stats.scanned += 1;
    let turns;
    try { turns = parseSession(ref.agent, ref.id); } catch { stats.skipped += 1; continue; }
    if (!passesFilters(ref, turns.length, st)) { stats.skipped += 1; continue; }


    // 项目名取会话级 cwd（首个带 cwd 的 turn；assistant 轮常无 cwd，逐轮取会把
    // 决定句漏进 global；claude 的 ref.cwd 是目录名推导也不可靠）
    const sessCwd = turns.find(t => t.cwd)?.cwd ?? ref.cwd;
    const project = cwdToProject(sessCwd);
    // 任务上下文提取（TodoWrite 调用 → tasks.json）；M2 起两层结构（活跃快照 +
    // 历史归档）。M3 回流：本轮**新归档**的 completed 任务组装为 Candidate 走
    // 既有蒸馏管线（与 LLM 精炼/分档/搁置同待遇），每条带独立 L0 事件源。
    let reflux: Candidate[] = [];
    {
      const tasks = extractTasksFromTurns(turns, ref.id, project);
      if (tasks.length > 0) {
        const git = collectGitContext(sessCwd);
        if (git.branch || git.changed) {
          for (const t of tasks) { t.branch = git.branch; t.changed = git.changed; }
        }
        const beforeKeys = new Set(loadStore().history.map(taskKey));
        saveStore(mergeStoreTasks(loadStore(), tasks));
        const newlyArchived = loadStore().history.filter(t => !beforeKeys.has(taskKey(t)));
        try { reflux = taskRefluxCandidates(newlyArchived); } catch { /* 溯源失败不阻塞蒸馏 */ }
      }
    }
    const candidates = [...extractCandidates(turns, { projectOverride: project }), ...reflux];
    if (candidates.length === 0) {
      // 没有候选也记录，避免反复解析
      try { recordSessionDistill({ id: ref.id, sourceId: '' }); } catch { /* 尽力 */ }
      continue;
    }

    await withEngine(async held => {
      // 第一遍 dry-run（不带 turns：不落 L0 source）拿 duplicate/similarity 分档
      const dry = await distill(held.engine, candidates.map(c => ({ ...c })), { apply: false, agent: ref.agent, refiner: distillRefiner ?? undefined });
      const classified = dry.candidates;

      const safe: Candidate[] = [];
      const toShelve: { c: Candidate; reason: string }[] = [];
      for (const c of classified) {
        if (st.mode === 'review') { toShelve.push({ c, reason: 'review-mode' }); continue; }
        if (c.duplicate === 'reinforce' || c.duplicate === 'supersede') safe.push(c);
        else if (c.duplicate === 'maybe') toShelve.push({ c, reason: 'maybe' });
        else if (c.confidence < st.threshold) toShelve.push({ c, reason: 'low-conf' });
        else safe.push(c);
      }

      // 需要搁置或入库的都留 source（L0 溯源，以后可回放/重蒸馏）
      const needSource = safe.length > 0 || toShelve.length > 0;
      const sourceId = needSource
        ? saveSource(turns.map(t => ({ role: t.role, text: t.text, cwd: t.cwd, ts: t.ts, tool_name: t.toolName, tool_failed: t.toolFailed, model: t.model })), { project, agent: ref.agent })
        : '';

      if (safe.length > 0) {
        const applied = await distill(held.engine, safe.map(c => ({ ...c })), { apply: true, agent: ref.agent, sourceId, refiner: distillRefiner ?? undefined });
        stats.created += applied.created;
        stats.reinforced += applied.reinforced;
        stats.superseded += applied.candidates.filter(c => c.duplicate === 'supersede').length;
      }
      for (const { c, reason } of toShelve) {
        appendShelved({ candidate: { ...c, source_id: c.source_id || sourceId }, sessionId: ref.id, sourceId, reason, createdAt: Date.now() / 1000 } satisfies ShelvedCandidate);
        stats.shelved += 1;
      }

      try {
        recordSessionDistill({
          id: ref.id, sourceId,
          created: safe.length, reinforced: 0, maybe: toShelve.length,
        });
      } catch { /* 尽力 */ }
    });
  }

  const next = { ...st, lastRunAt: Date.now() / 1000, lastRun: stats };
  saveAutoSettings(next);

  // 编译自动化：产生了新记忆 → 自动重编译所有已配置的项目
  if (stats.created > 0 || stats.reinforced > 0) {
    void autoRecompile().catch(() => {});
  }

  // 治理自动化（H9②）：
  // a) 待审队列积压 ≥20 条且注入了 LLM → 后台预审打建议（不阻塞本轮返回）
  // b) 每日一轮 sleep 整合（去重/衰减/清过期），上次跑距 now ≥20h 才跑
  if (stats.shelved > 0 || listShelved().length >= 20) {
    const refiner = getDistillRefiner();
    if (refiner !== null) {
      void (async () => {
        try {
          const { reviewShelved } = await import('./shelved-review.js');
          const st = await reviewShelved((sys, u) => refinerBridge(sys, u));
          if (st.reviewed > 0) console.log(`[auto-review] 待审预审完成：${st.reviewed} 条（建议收 ${st.accept} / 弃 ${st.discard}）`);
        } catch { /* 预审失败不影响主流程 */ }
      })();
    }
  }
  void maybeAutoSleep();

  return stats;
}

/** refiner 注入的是 Candidate 级 CompleteFn；预审复用同一通道。 */
let refinerBridge: (system: string, user: string) => Promise<string> = async () => { throw new Error('LLM 未接入'); };
export function setRefinerBridge(fn: (system: string, user: string) => Promise<string>): void {
  refinerBridge = fn;
}

/** 每日 sleep：距上次 ≥20h 才跑（settings 里记 lastSleepAt）。 */
async function maybeAutoSleep(): Promise<void> {
  try {
    const st = loadAutoSettings();
    const now = Date.now() / 1000;
    const last = (st as unknown as { lastSleepAt?: number }).lastSleepAt ?? 0;
    if (now - last < 20 * 3600) return;
    const { runSleep } = await import('./sleep.js');
    const { withEngine } = await import('./engine-holder.js');
    let merged = 0;
    let dropped = 0;
    await withEngine(async ({ engine }) => {
      const report = await runSleep(engine as never, { apply: true });
      merged = report.merged;
      dropped = report.staleShelvedDropped;
    });
    (st as unknown as { lastSleepAt?: number }).lastSleepAt = now;
    saveAutoSettings(st);
    console.log(`[auto-sleep] 整合完成：合并 ${merged} · 清过期待审 ${dropped}`);
  } catch { /* sleep 失败不影响蒸馏 */ }
}

/** 自动重编译已配置的项目（编译配置见 compile-config.ts）。 */
export async function autoRecompile(): Promise<void> {
  const { loadCompileConfig } = await import('./compile-config.js');
  const { exportRecords } = await import('./transfer.js');
  const { compileTarget } = await import('./compile.js');
  const { withEngine: withEngineFn } = await import('./engine-holder.js');

  const config = loadCompileConfig();
  if (config.targets.length === 0) return;

  await withEngineFn(async ({ engine }) => {
    for (const target of config.targets) {
      try {
        const records = exportRecords(engine.store as never, { project: target.project }) as unknown as never[];
        const active = (records as Array<Record<string, unknown>>).filter(r => !r.superseded_by);
        const result = compileTarget(target.target as never, active as never, {
          outPath: target.outPath,
        });
        target.lastCompiledAt = Date.now() / 1000;
        target.lastMemoryCount = result.memoryCount;
        console.log(`[auto-compile] ${target.project} → ${target.outPath} (${result.memoryCount} memories)`);
      } catch (err) {
        console.error(`[auto-compile] ${target.project} 失败:`, (err as Error).message);
      }
    }
    const { saveCompileConfig } = await import('./compile-config.js');
    saveCompileConfig(config);
  }).catch(() => {});
}

/** 定时器（server 启动时挂，mode=off 不启动）。返回停止函数。 */
export function startAutoDistillTimer(): () => void {
  const st = loadAutoSettings();
  if (st.mode === 'off') return () => {};
  const intervalMs = Math.max(5, st.intervalMin) * 60 * 1000;
  const timer = setInterval(() => {
    void runAutoDistillOnce().catch(() => {});
  }, intervalMs);
  timer.unref?.();
  // 启动后延迟首跑，给会话索引同步留时间
  const first = setTimeout(() => { void runAutoDistillOnce().catch(() => {}); }, 30_000);
  first.unref?.();
  return () => { clearInterval(timer); clearTimeout(first); };
}

void fs;
