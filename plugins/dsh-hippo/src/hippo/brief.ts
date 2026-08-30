/**
 * 项目简报（project brief）：把一个项目的跨会话记忆/任务整合成
 * "最新情况"——时间感知的浓缩视图。
 *
 * 用户场景：多个对话都在搞同一个项目（各问不同问题、调研不同东西），
 * 想要"整合起来看现在到哪了"。distill 已按 project 聚合记忆，compile
 * 是全量罗列；brief 补上缺的时间维度：
 *
 *   ● 状态：活跃/休眠（7 天阈值，与 project-card 一致）+ 记忆量
 *   ● 任务：完成度 + 进行中任务
 *   ● 近 7 天新知：新蒸馏的记忆置顶（用户最关心的"最新情况"）
 *   ● 更早沉淀：折叠为计数（老记忆不占注意力，需要时用 recall 查）
 *
 * 纯规则零 LLM——记忆带 created_at，按时间窗口分桶即可。会话数来自
 * sessions 目录统计（有则显示）。
 */
import type { MemoryRecord } from './memory.js';
import { loadTasks } from './task-context.js';

const RECENT_DAYS = 7;
const RECENT_LIMIT = 8;

const ZH_TYPE: Record<string, string> = { fact: '事实', decision: '决策', lesson: '教训', preference: '偏好' };

function daysAgo(ts: number, now: number): number {
  return Math.floor((now - ts) / 86400);
}

export interface BriefOptions {
  project?: string;
  /** 覆盖"现在"（测试用）：epoch seconds。 */
  now?: number;
}

/** 生成项目简报 markdown。返回空串 = 没有该项目的任何记忆/任务。 */
export function projectBrief(records: MemoryRecord[], opts: BriefOptions = {}): string {
  const now = opts.now ?? Date.now() / 1000;
  const project = opts.project ?? '';
  const scoped = project !== '' ? records.filter(r => r.project === project) : records;
  const tasks = project !== ''
    ? loadTasks().filter(t => t.project === project)
    : loadTasks();

  if (scoped.length === 0 && tasks.length === 0) return '';

  // 按时间倒序（最新在前）
  const sorted = [...scoped].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const recent = sorted.filter(r => (now - (r.created_at ?? 0)) < RECENT_DAYS * 86400).slice(0, RECENT_LIMIT);
  const olderCount = sorted.length - recent.length;

  const open = tasks.filter(t => t.status !== 'completed');
  const done = tasks.filter(t => t.status === 'completed');
  const active = sorted.length > 0 && (now - (sorted[0].created_at ?? 0)) < RECENT_DAYS * 86400;
  const asOf = new Date(now * 1000);
  const date = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, '0')}-${String(asOf.getDate()).padStart(2, '0')}`;

  const lines: string[] = [];
  lines.push(`## Project Brief: ${project !== '' ? project : '（全部项目）'}（截至 ${date}）`, '');

  // 状态行
  const bits: string[] = [];
  bits.push(active ? '● 活跃' : '○ 休眠');
  bits.push(`${scoped.length} 条记忆`);
  const firstAt = sorted.length > 0 ? sorted[sorted.length - 1].created_at ?? 0 : 0;
  if (firstAt > 0) bits.push(`首条 ${daysAgo(firstAt, now)} 天前`);
  if (sorted.length > 0) {
    lines.push(bits.join(' · '));
  }

  // 任务
  if (tasks.length > 0) {
    lines.push('');
    lines.push(`● 任务：${done.length}/${tasks.length} 完成`);
    for (const t of open.slice(0, 5)) {
      const mark = t.status === 'in_progress' ? '▶' : '○';
      lines.push(`  ${mark} ${t.text.slice(0, 60)}${t.priority === 'high' ? ' ⚑' : ''}`);
    }
    if (open.length > 5) lines.push(`  … 共 ${open.length} 项未完成`);
  }

  // 近期新知
  if (recent.length > 0) {
    lines.push('');
    lines.push(`● 近 ${RECENT_DAYS} 天新知：`);
    for (const r of recent) {
      const type = ZH_TYPE[r.type] ?? r.type;
      const d = daysAgo(r.created_at ?? 0, now);
      const when = d === 0 ? '今天' : d === 1 ? '昨天' : `${d} 天前`;
      lines.push(`  ⭐ ${r.text.slice(0, 80)}（${type}·${when}）`);
    }
  }

  // 更早沉淀
  if (olderCount > 0) {
    lines.push('');
    lines.push(`● 更早沉淀：${olderCount} 条（用 recall 按需检索，不在此罗列）`);
  }

  return lines.join('\n');
}

/**
 * 便捷入口：自动取数生成项目简报（dsh 插件/GUI 零样板调用）。
 * 短持引擎读 records → projectBrief；project 空 = 全部项目。
 *
 * 全 dynamic import 断模块环（engine.ts re-export 本模块，若此处静态
 * import engine-holder 会形成 engine→brief→engine-holder→engine 环）。
 */
export async function projectBriefAuto(project: string): Promise<string> {
  const [{ withEngine }, { exportRecords }] = await Promise.all([
    import('./engine-holder.js'),
    import('./transfer.js'),
  ]);
  return withEngine(async ({ store }) => {
    const records = exportRecords(store as Parameters<typeof exportRecords>[0], {
      project: project !== '' ? project : undefined,
    }) as unknown as Parameters<typeof projectBrief>[0];
    return projectBrief(records, { project });
  }, 5000);
}
