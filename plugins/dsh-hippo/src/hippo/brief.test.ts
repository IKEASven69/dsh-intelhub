/**
 * projectBrief 测试:时间分桶、任务整合、空态防御。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectBrief } from './brief.js';
import type { MemoryRecord } from './memory.js';

const DAY = 86400;

function mem(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: Math.random().toString(36).slice(2), text: 'x', type: 'fact',
    project: 'hippo', agent: 'test', created_at: 0, accessed_at: 0, strength: 1,
    source_id: '', source_offset: -1, ...over,
  };
}

function withTasks(tasks: unknown[], fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-brief-'));
  const prev = process.env.HIPPO_DATA_DIR;
  process.env.HIPPO_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(tasks));
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env.HIPPO_DATA_DIR; else process.env.HIPPO_DATA_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* EPERM */ }
  }
}

const NOW = 1_800_000_000; // 固定"现在"(测试锚点)

test('recent memories starred and first; older folded into a count', () => {
  withTasks([], () => {
    const out = projectBrief([
      mem({ text: '新决策', type: 'decision', created_at: NOW - 1 * DAY }),
      mem({ text: '老记忆', created_at: NOW - 30 * DAY }),
    ], { project: 'hippo', now: NOW });
    assert.ok(out.includes('⭐ 新决策'), '近期记忆带 ⭐');
    assert.ok(!out.includes('⭐ 老记忆'), '老记忆不带 ⭐');
    assert.ok(out.includes('更早沉淀：1 条'), '老记忆折叠为计数');
    assert.ok(out.includes('● 活跃'), '近 7 天有记忆 → 活跃');
  });
});

test('tasks integrate: completion ratio + open list with high-priority flag', () => {
  withTasks([
    { project: 'hippo', text: '修书签 bug', status: 'completed', priority: 'high', updatedAt: NOW - 10, sessionId: 's1' },
    { project: 'hippo', text: '编译闭环', status: 'in_progress', priority: 'high', updatedAt: NOW - 5, sessionId: 's1' },
    { project: 'other', text: '别的项目任务', status: 'pending', priority: 'low', updatedAt: NOW - 5, sessionId: 's2' },
  ], () => {
    const out = projectBrief([mem({ created_at: NOW - 1 * DAY })], { project: 'hippo', now: NOW });
    assert.ok(out.includes('任务：1/2 完成'), '完成度按项目过滤');
    assert.ok(out.includes('▶ 编译闭环 ⚑'), '进行中任务 + 高优标记');
    assert.ok(!out.includes('别的项目任务'), '不泄漏其他项目任务');
  });
});

test('dormant when nothing recent; empty when no data at all', () => {
  withTasks([], () => {
    const dormant = projectBrief([mem({ created_at: NOW - 30 * DAY })], { project: 'hippo', now: NOW });
    assert.ok(dormant.includes('○ 休眠'), '近 7 天无记忆 → 休眠');
    const empty = projectBrief([], { project: 'hippo', now: NOW });
    assert.equal(empty, '', '无记忆无任务 → 空串');
  });
});

test('project filter scopes memories; omitted project covers all', () => {
  withTasks([], () => {
    const scoped = projectBrief([
      mem({ text: '本项目的', project: 'hippo', created_at: NOW - DAY }),
      mem({ text: '别的项目', project: 'other', created_at: NOW - DAY }),
    ], { project: 'hippo', now: NOW });
    assert.ok(scoped.includes('本项目的'));
    assert.ok(!scoped.includes('别的项目'));
    const all = projectBrief([
      mem({ text: 'a', project: 'p1', created_at: NOW - DAY }),
      mem({ text: 'b', project: 'p2', created_at: NOW - DAY }),
    ], { now: NOW });
    assert.ok(all.includes('a') && all.includes('b'), '不传 project = 全部');
  });
});
