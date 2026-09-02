/**
 * 任务完成回流（M3）：completed 任务组装为 distill Candidate 走既有管线。
 *
 * §0.2 判断 3：Candidate 是事件→知识的唯一车票——回流不是旁路写入 zvec，
 * 而是和会话蒸馏同一条管线（同样的 dedup/similarity 分档、同样的 LLM 精炼
 * 对账、同样的 review 搁置）。任务状态本身仍不进 zvec（§3 出界声明）：
 * 进去的只是"这件事做完了、当时的 git 痕迹"这条事实。
 *
 * 溯源：每条完成记录落一个独立 L0 事件源 blob（内含 sessionId + 完整
 * TaskRecord，含 branch/changed/updatedAt），候选自带 source_id——
 * distill() 无 turns 时保留候选自带值；auto-distill 有 turns 场景由
 * distill.ts 的守卫（不覆盖已设 source_id）保证按任务溯源不串会话。
 */
import { makeCandidate, type Candidate } from './distill.js';
import { saveSource } from './sources.js';
import type { TaskRecord } from './task-context.js';

/** 回流候选的 agent 标识（remember 记账 / L0 blob 元数据用）。 */
export const TASK_REFUX_AGENT = 'distill:task';

/** 完成事实的正文：任务内容 + 完成日期 + 当时 git 痕迹（branch + changed 摘要）。 */
export function taskCompletionText(t: TaskRecord): string {
  const date = new Date(t.updatedAt * 1000).toISOString().slice(0, 10);
  const parts: string[] = [];
  if (t.branch) parts.push(`分支 ${t.branch}`);
  if (t.changed?.length) {
    const head = t.changed.slice(0, 5).join(', ');
    parts.push(`改动 ${t.changed.length} 文件: ${head}${t.changed.length > 5 ? ' …' : ''}`);
  }
  return `完成任务: ${t.text}（${date}${parts.length ? '，' + parts.join('，') : ''}）`;
}

/** 单条完成记录 → Candidate（纯组装，不落盘不进管线）。 */
export function taskCompletionCandidate(t: TaskRecord): Candidate {
  return makeCandidate({
    text: taskCompletionText(t),
    type: 'fact',
    project: t.project,
    confidence: 0.7,
    source_rule: 'task_completion',
  });
}

/** L0 事件源：单条任务完成记录的完整 TaskRecord 存为 source blob，返回 source_id。 */
export function saveCompletionSource(t: TaskRecord, dataDir?: string): string {
  return saveSource(
    [{
      role: 'system',
      text: JSON.stringify(t),
      cwd: '',
      ts: new Date(t.updatedAt * 1000).toISOString(),
      tool_name: 'TodoWrite',
    }],
    { project: t.project, agent: TASK_REFUX_AGENT, dataDir },
  );
}

/**
 * 批量回流入口：新归档的 completed 任务 → 带独立 L0 溯源的候选列表。
 * 非 completed 的归档（如中途消失的 pending）不回流——只有完成才值得沉淀。
 */
export function taskRefluxCandidates(tasks: TaskRecord[], dataDir?: string): Candidate[] {
  return tasks
    .filter(t => t.status === 'completed')
    .map(t => {
      const c = taskCompletionCandidate(t);
      c.source_id = saveCompletionSource(t, dataDir);
      return c;
    });
}
