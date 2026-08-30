/**
 * Engine assembly: wire the zvec store to the configured embedding
 * provider and return a ready MemoryEngine. Shared by the CLI and the
 * MCP server.
 */
import { getProvider } from '../core/search/index.js';
import { MemoryEngine } from './memory.js';
import { dataDir } from './store.js';
import { ZvecStore } from './zvec-store.js';

// 公共管线件再导出：宿主（dsh-hippo 等记忆桥插件）需要从包根引入
// 解析/抽取/蒸馏三段，而不是深挖 dist 路径。
export { distill, extractCandidates, MAX_CANDIDATES } from './distill.js';
export type { Candidate, DistillResult } from './distill.js';
export type { MemoryRecord, RecallHit } from './memory.js';
export { compileTarget, groupMemories, renderAgentsMd, injectSection } from './compile.js';
export type { CompileTarget, GroupedMemories } from './compile.js';
export { parseJsonl, entryToTurns, cwdToProject, makeTurn } from '../patterns/transcript.js';
export type { Turn } from '../patterns/transcript.js';
// 会话适配器层（GUI 浏览 / distill / dsh 插件 import 三个消费者共用）
export { AGENTS, inventory, discoverAll, parseSession, loadIgnoreRules, readImportState, writeImportState } from '../agents/index.js';
export type { SessionAdapter, SessionRef, AgentInventory, IgnoreRules, ImportState } from '../agents/index.js';
// 会话索引层（G1）：搜索/详情/导出/蒸馏记录
export {
  syncSessionIndex, listSessions, getIndexedSession, searchSessions,
  indexStats, turnCountMap, recordSessionDistill, listSessionDistills,
} from '../agents/session-index.js';
export type { IndexedSession, SessionSearchHit, SyncResult, SessionDistillRecord } from '../agents/session-index.js';
export { renderSessionMarkdown, renderSessionJson, safeFileStem } from '../agents/export.js';
export { resumePlanFor, launchTerminal } from '../agents/resume.js';
// 团队记忆核心（T 系列：两层模型，GUI 与 dsh-team-memory 插件共用）
export { readTeamEvents } from '../team/adapter.js';
export { distillTeamEvents } from '../team/distill.js';
export { foldLedger, readLedger, appendLedger, ledgerPath } from '../team/ledger.js';
export { triage, resolvePromotion, resolveRetirement } from '../team/triage.js';
export { renderTeamMemoryMarkdown } from '../team/export-md.js';
export { runCycle } from '../team/cycle.js';
// 生活流（life K0）：居民/频道/账本/游标
export {
  createResident, listResidents, getResident, deleteResident, residentJoinChannel,
  createChannel, listChannels, getChannel, deleteChannel,
  appendMessage, readMessages, readBookmark, writeBookmark,
} from '../life/store.js';
export type { Resident, Channel, ChannelMessage, ResidentState } from '../life/types.js';
export type { TeamEvent, MemoryEntry, PromotionCandidate, RetirementCandidate, ScanReport, LedgerEvent, TeamMemoryType } from '../team/types.js';
// 引擎短持（G2 读写分离）：zvec 单写锁的引用计数 + 忙等重试，GUI 与 dsh 插件共用
export { acquireEngine, withEngine } from './engine-holder.js';
export type { HeldEngine } from './engine-holder.js';
// 自动蒸馏（AD）：设置/搁置队列/扫描器——GUI 与 dsh 插件共用
export {
  loadAutoSettings, saveAutoSettings, listShelved, appendShelved, takeShelved,
  type AutoDistillSettings, type AutoMode, type ShelvedCandidate,
} from './auto-distill.js';
export { runAutoDistillOnce, startAutoDistillTimer, setDistillRefiner, getDistillRefiner, type AutoRunStats } from './auto-distill-run.js';
export { llmRefine, parseVerdicts, type CompleteFn } from './refine.js';
export { runSleep, type SleepReport, type DupCluster } from './sleep.js';
export { deleteSession, ignoreSession, type DeleteSessionResult } from '../agents/session-delete.js';

export interface OpenedEngine {
  engine: MemoryEngine;
  store: ZvecStore;
  close(): void;
}

export function openEngine(dir?: string): OpenedEngine {
  const provider = getProvider();
  const store = new ZvecStore(dir ?? dataDir(), provider.dim);
  const engine = new MemoryEngine(store, (text) => provider.embed(text));
  return { engine, store, close: () => store.close() };
}

// Telegram Bot（P2）：手机端白嫖引擎
export { startTelegramBot, type TelegramConfig } from './telegram.js';

// Skill 线阶段一：从 L0 提取修正模式（纯规则零 LLM）
export { extractSkillCandidates, type CorrectionPattern, type SkillExtractReport } from './skill-extract.js';

// 任务上下文（操作性上下文）
export { loadTasks, saveTasks, tasksForProject, updateTaskStatus, type TaskRecord } from './task-context.js';
export { projectCard, type ProjectCard } from './project-card.js';
export { projectBrief, projectBriefAuto, type BriefOptions } from './brief.js';
