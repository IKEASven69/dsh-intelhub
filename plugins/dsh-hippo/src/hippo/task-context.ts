/**
 * 任务上下文（操作性上下文）：从会话 TodoWrite 调用提取结构化任务记录。
 *
 * TodoWrite 是跨 agent 的事实标准（zcode / Claude Code / Codex 都用），
 * 格式统一：{todos:[{content,status,priority}]}，带时间戳和 cwd。
 *
 * 存储：~/.hippo/tasks.json（轻量旁挂，不进 zvec——任务是操作状态不是知识）。
 * 更新策略：每次扫描取最新的 TodoWrite 调用覆盖旧任务（任务是快照不是增量）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { appPath } from '../core/paths.js';
import type { Turn } from '../patterns/transcript.js';

export interface TaskRecord {
  project: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
  updatedAt: number; // epoch seconds
  sessionId: string;
  /** git 维度（M1）：采集时刻的分支名。非 git 目录/采集失败时缺省。 */
  branch?: string;
  /** git 维度（M1）：采集时刻的工作区改动文件列表（git status --short 解析，
   *  含 untracked——M0 实测发现 diff --stat 漏 untracked，故改用 status）。
   *  上限 50 条防 tasks.json 膨胀；空改动/非 git 目录时缺省。 */
  changed?: string[];
}

const TASKS_FILE = () => appPath('tasks.json');

// ── 两层存储（M2）：活跃层快照 + 历史层按 sessionId 归档 ───────────────────
// 纯快照语义答不了"昨天卡在哪"（冷神需求），故在快照之上加历史归档层。
// 归档模式参照 team 线 retirement 的简化版：任务从 TodoWrite 快照中消失即归档，
// 保留完成时刻的 updatedAt 与当时 git 状态（branch/changed）。

export interface TasksStoreV2 {
  version: 2;
  active: TaskRecord[];
  history: TaskRecord[];
}

/** 历史层全局上限：任务归档是低频事件，2000 条足够跨数月回溯，防 tasks.json 无界膨胀。 */
const HISTORY_CAP = 2000;

/** 读 tasks.json，老格式（裸 TaskRecord[]）自动迁移为 v2 两层结构。 */
export function loadStore(): TasksStoreV2 {
  try {
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE(), 'utf-8')) as unknown;
    if (Array.isArray(raw)) {
      return { version: 2, active: raw as TaskRecord[], history: [] };
    }
    if (raw && typeof raw === 'object' && (raw as TasksStoreV2).version === 2) {
      const st = raw as TasksStoreV2;
      return { version: 2, active: st.active ?? [], history: st.history ?? [] };
    }
    return { version: 2, active: [], history: [] };
  } catch {
    return { version: 2, active: [], history: [] };
  }
}

export function saveStore(store: TasksStoreV2): void {
  fs.mkdirSync(path.dirname(TASKS_FILE()), { recursive: true });
  fs.writeFileSync(TASKS_FILE(), JSON.stringify(store, null, 2), 'utf-8');
}

export function loadTasks(): TaskRecord[] {
  return loadStore().active;
}

/** 写活跃层，保留既有历史层（兼容老调用点）。 */
export function saveTasks(tasks: TaskRecord[]): void {
  const store = loadStore();
  saveStore({ ...store, active: tasks });
}

/** 历史层 dedupe 键（导出供回流 diff 用）：project\0sessionId\0text。 */
export function taskKey(t: TaskRecord): string {
  return `${t.project}\u0000${t.sessionId}\u0000${t.text}`;
}

/**
 * 两层合并（M2 核心）：incoming 是某会话最新 TodoWrite 快照，替换该项目的活跃层；
 * 上一版活跃层中从快照里**消失**的任务追加进历史层（dedupe 键 project+sessionId+text，
 * 保留 updatedAt 最新的一条——完成时刻与当时 git 状态随之留存）。
 */
export function mergeStoreTasks(store: TasksStoreV2, incoming: TaskRecord[]): TasksStoreV2 {
  if (incoming.length === 0) return store;
  const project = incoming[0].project;
  const prev = store.active.filter(t => t.project === project);
  const rest = store.active.filter(t => t.project !== project);
  const incomingTexts = new Set(incoming.map(t => t.text));
  const disappeared = prev.filter(t => !incomingTexts.has(t.text));

  const history = [...store.history];
  for (const t of disappeared) history.push(t);
  // dedupe：同 (project, sessionId, text) 只留 updatedAt 最新
  const byKey = new Map<string, TaskRecord>();
  for (const t of history) {
    const key = taskKey(t);
    const cur = byKey.get(key);
    if (!cur || t.updatedAt > cur.updatedAt) byKey.set(key, t);
  }
  const deduped = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    version: 2,
    active: [...rest, ...incoming],
    history: deduped.slice(0, HISTORY_CAP),
  };
}

/** 历史层查询：按项目（可选再按 sessionId）取归档任务轨迹。 */
export function taskHistory(project: string, sessionId?: string): TaskRecord[] {
  const h = loadStore().history.filter(t => t.project === project);
  return sessionId ? h.filter(t => t.sessionId === sessionId) : h;
}

/**
 * 兼容包装（老签名）：仅活跃层合并语义，历史层不参与。
 * 生产路径请用 mergeStoreTasks + saveStore（auto-distill-run.ts）。
 */
export function mergeTasks(existing: TaskRecord[], incoming: TaskRecord[]): TaskRecord[] {
  return mergeStoreTasks({ version: 2, active: existing, history: [] }, incoming).active;
}

/** 从 Turn 流中提取 TodoWrite 调用的任务列表。 */
export function extractTasksFromTurns(turns: Turn[], sessionId: string, project: string): TaskRecord[] {
  const out: TaskRecord[] = [];
  let latestTs = 0;

  for (const turn of turns) {
    if (turn.toolName !== 'TodoWrite') continue;
    // ts 是 ISO 字符串
    const ts = turn.ts ? Date.parse(turn.ts) / 1000 : 0;
    if (ts < latestTs) continue; // 只取最新的 TodoWrite 调用（快照覆盖）
    latestTs = ts;

    try {
      // zcode 适配器把 tool 的 input+output 拼成一个 text（zcode.ts "input\noutput"），
      // TodoWrite 的 output 是 {oldTodos:...}，整段 JSON.parse 会失败——
      // 退化为只解析首行（工具输入是紧凑单行 JSON；claude/codex 单 JSON 不受影响）
      let data: { todos?: Array<{ content: string; status: string; priority?: string }> };
      try {
        data = JSON.parse(turn.text) as typeof data;
      } catch {
        data = JSON.parse(turn.text.split('\n')[0]) as typeof data;
      }
      if (!Array.isArray(data.todos)) continue;
      out.length = 0; // 覆盖之前的（同一会话内最新快照）
      for (const todo of data.todos) {
        if (typeof todo.content !== 'string' || todo.content.trim() === '') continue;
        out.push({
          project,
          text: todo.content.trim(),
          status: todo.status === 'completed' ? 'completed'
            : todo.status === 'in_progress' ? 'in_progress' : 'pending',
          priority: todo.priority === 'high' ? 'high' : todo.priority === 'low' ? 'low' : 'medium',
          updatedAt: ts,
          sessionId,
        });
      }
    } catch {
      continue; // text 不是 JSON 时跳过
    }
  }

  return out;
}

/** 按项目获取当前任务。 */
export function tasksForProject(project: string): TaskRecord[] {
  return loadTasks().filter(t => t.project === project);
}

// ── git 维度采集（M1）─────────────────────────────

/** changed 列表上限：正常会话改动远小于此，超限说明是批量生成/依赖目录，截断即可。 */
const CHANGED_CAP = 50;
const GIT_TIMEOUT_MS = 5000;

export interface GitContext {
  branch?: string;
  changed?: string[];
}

function gitRun(args: string, cwd: string): string | null {
  try {
    // 注意：不做整体 trim——status --short 首行的前导空格是格式的一部分
    // （"XY path"，XY 占两位），trim 掉会让首行解析错位
    return execSync(`git ${args}`, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).replace(/\r/g, '');
  } catch {
    return null; // 非 git 目录 / git 未安装 / 超时 → 静默降级
  }
}

/**
 * 采集目录的 git 行为痕迹（一手上下文，§5.2.2 一等公民）。
 * 非 git 目录静默返回 {}，不报错不落字段。
 */
export function collectGitContext(cwd: string): GitContext {
  if (!cwd) return {};
  const branch = (gitRun('rev-parse --abbrev-ref HEAD', cwd) ?? '').trim() || undefined;
  if (!branch) return {}; // 先探活：非 git 目录不再跑 status
  const status = gitRun('status --short', cwd) ?? '';
  const changed: string[] = [];
  for (const rawLine of status.split('\n')) {
    const line = rawLine.replace(/\s+$/, ''); // 仅去行尾（CR/空白），保行首格式
    if (!line) continue;
    // 格式 "XY path"；rename 为 "XY old -> new"，取 new
    const p = line.slice(3).trim();
    if (!p) continue;
    changed.push(p.includes(' -> ') ? p.split(' -> ').pop()!.trim() : p);
    if (changed.length >= CHANGED_CAP) break;
  }
  return {
    branch,
    changed: changed.length > 0 ? changed : undefined,
  };
}

/** 更新单条任务状态（MCP task_update 用）。 */
export function updateTaskStatus(project: string, text: string, status: TaskRecord['status']): boolean {
  const all = loadTasks();
  const task = all.find(t => t.project === project && t.text.includes(text.slice(0, 20)));
  if (!task) return false;
  task.status = status;
  task.updatedAt = Date.now() / 1000;
  saveTasks(all);
  return true;
}
