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
import { appPath } from '../core/paths.js';
import type { Turn } from '../patterns/transcript.js';

export interface TaskRecord {
  project: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
  updatedAt: number; // epoch seconds
  sessionId: string;
}

const TASKS_FILE = () => appPath('tasks.json');

export function loadTasks(): TaskRecord[] {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE(), 'utf-8')) as TaskRecord[];
  } catch {
    return [];
  }
}

export function saveTasks(tasks: TaskRecord[]): void {
  fs.mkdirSync(path.dirname(TASKS_FILE()), { recursive: true });
  fs.writeFileSync(TASKS_FILE(), JSON.stringify(tasks, null, 2), 'utf-8');
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
      const data = JSON.parse(turn.text) as {
        todos?: Array<{ content: string; status: string; priority?: string }>;
      };
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

/** 将提取的任务合并到全局任务表（同 project 的旧任务被新快照覆盖）。 */
export function mergeTasks(existing: TaskRecord[], incoming: TaskRecord[]): TaskRecord[] {
  if (incoming.length === 0) return existing;
  const project = incoming[0].project;
  // 同项目的旧任务整体替换（TodoWrite 是全量快照）
  const rest = existing.filter(t => t.project !== project);
  return [...rest, ...incoming];
}

/** 按项目获取当前任务。 */
export function tasksForProject(project: string): TaskRecord[] {
  return loadTasks().filter(t => t.project === project);
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
