/**
 * 项目卡片（派生数据，不新增存储）：从 stats + tasks 计算项目当前状态。
 * 用于编译的 Current State 节和 /api/projects/:name/card 端点。
 */
import { tasksForProject } from './task-context.js';
import type { MemoryEngine } from './memory.js';

export interface ProjectCard {
  project: string;
  status: 'active' | 'dormant';
  lastSessionAt: number;
  sessionCount: number;
  memoryCount: number;
  openTasks: number;
  completedTasks: number;
}

const ACTIVE_THRESHOLD_MS = 7 * 24 * 3600 * 1000; // 7天内有会话 = active

export function projectCard(
  project: string,
  engine: MemoryEngine,
  sessionStats: { lastUpdatedAt: number; count: number },
): ProjectCard {
  const tasks = tasksForProject(project);
  const records = (engine.store as unknown as {
    scan(): Array<[Record<string, unknown>]>;
  }).scan().map(([r]) => r as Record<string, unknown>);
  const memoryCount = records.filter(r => r.project === project).length;
  const active = Date.now() - sessionStats.lastUpdatedAt < ACTIVE_THRESHOLD_MS;

  return {
    project,
    status: active ? 'active' : 'dormant',
    lastSessionAt: sessionStats.lastUpdatedAt,
    sessionCount: sessionStats.count,
    memoryCount,
    openTasks: tasks.filter(t => t.status !== 'completed').length,
    completedTasks: tasks.filter(t => t.status === 'completed').length,
  };
}
