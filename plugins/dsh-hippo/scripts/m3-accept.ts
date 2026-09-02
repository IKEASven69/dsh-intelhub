/**
 * M3 验收：真实 zcode 会话回放 → 新归档 completed 任务 → taskRefluxCandidates
 * → L0 溯源回放验证 → distill dry-run 分档（fake embedding 只做形状验证，
 * 管线接口为真实调用）。
 */
import { discoverAll, parseSession } from '../src/agents/index.js';
import { extractTasksFromTurns, mergeStoreTasks, loadStore, saveStore, collectGitContext, taskKey } from '../src/hippo/task-context.js';
import { taskRefluxCandidates, taskCompletionText } from '../src/hippo/task-reflux.js';
import { loadSource } from '../src/hippo/sources.js';
import { distill } from '../src/hippo/distill.js';
import { MemoryEngine } from '../src/hippo/memory.js';
import { fakeEmbed, FakeStore } from '../src/hippo/test-helpers.js';
import * as fs from 'node:fs';

const DATA = 'C:/Users/20369/AppData/Local/Temp/hippo-m3-accept';
fs.rmSync(DATA, { recursive: true, force: true });
process.env.HIPPO_DATA_DIR = DATA;

const refs = discoverAll().filter(r => r.agent === 'zcode');
const sessions: { id: string; ts: number; cwd: string; tasks: ReturnType<typeof extractTasksFromTurns> }[] = [];
for (const ref of refs) {
  try {
    const turns = parseSession(ref.agent, ref.id);
    const tasks = extractTasksFromTurns(turns, ref.id, 'proj');
    if (tasks.length > 0) sessions.push({ id: ref.id, ts: tasks[0].updatedAt, cwd: ref.cwd, tasks });
  } catch { /* 跳过 */ }
}
sessions.sort((a, b) => a.ts - b.ts);

// 按时间回放，收集全部新归档任务
const archived: typeof sessions[number]['tasks'] = [];
for (const s of sessions) {
  const git = collectGitContext(s.cwd);
  if (git.branch || git.changed) for (const t of s.tasks) { t.branch = git.branch; t.changed = git.changed; }
  const beforeKeys = new Set(loadStore().history.map(taskKey));
  saveStore(mergeStoreTasks(loadStore(), s.tasks));
  archived.push(...loadStore().history.filter(t => !beforeKeys.has(taskKey(t))));
}
console.log(`回放 ${sessions.length} 个真实会话 → 新归档 ${archived.length} 条（completed ${archived.filter(t => t.status === 'completed').length}）`);

// 回流：组装候选 + L0 事件源
const cands = taskRefluxCandidates(archived, DATA);
console.log(`回流候选 ${cands.length} 条:`);
for (const c of cands.slice(0, 5)) console.log(`  - ${c.text}`);
if (cands.length > 5) console.log(`  … 共 ${cands.length} 条`);

// L0 溯源回放验证
const c0 = cands[0];
if (c0) {
  const blob = loadSource(c0.source_id!, { dataDir: DATA });
  const raw = JSON.stringify(blob);
  console.log(`\nL0 溯源回放: blob 存在=${!!blob}, 含 sessionId=${raw.includes('sess_')}, 含 changed=${raw.includes('changed')}`);
}

// distill dry-run 分档（真实管线接口）
const engine = new MemoryEngine(new FakeStore(), fakeEmbed);
const dry = await distill(engine, cands.map(c => ({ ...c })), { apply: false, agent: 'distill:task' });
const bands = new Map<string, number>();
for (const c of dry.candidates) bands.set(c.duplicate, (bands.get(c.duplicate) ?? 0) + 1);
console.log(`\ndistill dry-run 分档: ${JSON.stringify([...bands])}（首轮回放无既有记忆 → 全 new 属预期）`);
fs.rmSync(DATA, { recursive: true, force: true });
