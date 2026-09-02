/**
 * task-reflux M3 测试：完成事实组装、L0 事件源溯源、distill 管线同待遇
 * （候选自带 source_id 不被会话级 blob 覆盖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  taskCompletionText, taskCompletionCandidate, taskRefluxCandidates, TASK_REFUX_AGENT,
} from './task-reflux.js';
import { loadSource } from './sources.js';
import { distill } from './distill.js';
import { MemoryEngine } from './memory.js';
import { fakeEmbed, FakeStore } from './test-helpers.js';
import type { TaskRecord } from './task-context.js';

function withEnv(fn: () => Promise<void> | void): Promise<void> | void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-reflux-'));
  const prev = process.env.HIPPO_DATA_DIR;
  process.env.HIPPO_DATA_DIR = dir;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.HIPPO_DATA_DIR; else process.env.HIPPO_DATA_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* EPERM on win */ }
  }
}

function mkTask(partial: Partial<TaskRecord> = {}): TaskRecord {
  return {
    project: 'proj', text: '修好登录页白屏', status: 'completed', priority: 'medium',
    updatedAt: Date.parse('2026-09-01T12:00:00Z') / 1000, sessionId: 'sess_abc123',
    ...partial,
  };
}

test('taskCompletionText: 带分支与改动摘要，changed 超 5 条截断加 …', () => {
  const full = taskCompletionText(mkTask({
    branch: 'feat/login',
    changed: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'],
  }));
  assert.ok(full.includes('完成任务: 修好登录页白屏'));
  assert.ok(full.includes('2026-09-01'));
  assert.ok(full.includes('分支 feat/login'));
  assert.ok(full.includes('改动 7 文件'));
  assert.ok(full.includes('a.ts, b.ts, c.ts, d.ts, e.ts'));
  assert.ok(full.endsWith('…）'), '超出部分用 … 截断');

  const bare = taskCompletionText(mkTask());
  assert.ok(bare.includes('完成任务: 修好登录页白屏'));
  assert.ok(!bare.includes('分支') && !bare.includes('改动'), '无 git 痕迹时不硬凑字段');
});

test('taskCompletionCandidate: type=fact / source_rule=task_completion / confidence 0.7', () => {
  const c = taskCompletionCandidate(mkTask());
  assert.equal(c.type, 'fact');
  assert.equal(c.source_rule, 'task_completion');
  assert.equal(c.confidence, 0.7);
  assert.equal(c.project, 'proj');
});

test('taskRefluxCandidates: 只回流 completed，每条带独立 L0 溯源（blob 含 sessionId）', () => {
  withEnv(() => {
    const cands = taskRefluxCandidates([
      mkTask({ text: '完成的', branch: 'main', changed: ['x.ts'] }),
      mkTask({ text: '没做完就消失', status: 'pending' }),
      mkTask({ text: '进行中', status: 'in_progress' }),
    ]);
    assert.equal(cands.length, 1, '只有 completed 回流');
    const c = cands[0];
    assert.ok(c.source_id, '候选应自带 source_id');
    const blob = loadSource(c.source_id!);
    assert.ok(blob, 'L0 事件源可回放');
    const raw = JSON.stringify(blob);
    assert.ok(raw.includes('sess_abc123'), 'blob 应含 sessionId');
    assert.ok(raw.includes('x.ts'), 'blob 应含完整 TaskRecord（git 痕迹）');
    assert.ok(raw.includes('完成的'));
  });
});

test('distill 管线同待遇：候选自带 source_id 不被会话级 sourceId 覆盖，且落库用它', async () => {
  await withEnv(async () => {
    const cands = taskRefluxCandidates([mkTask()]);
    assert.equal(cands.length, 1);
    const taskBlobId = cands[0].source_id!;
    // 模拟 auto-distill 场景：apply 时传了会话级 sourceId
    const engine = new MemoryEngine(new FakeStore(), fakeEmbed);
    const result = await distill(engine, cands, { apply: true, agent: TASK_REFUX_AGENT, sourceId: 'sess-blob-should-not-win' });
    assert.equal(result.created, 1);
    assert.equal(cands[0].source_id, taskBlobId, '候选自带溯源不被覆盖');
    // 落库记录的 source_id 应是任务 blob 而非会话 blob
    const hits = await engine.store.search(await engine.embedder(cands[0].text), ['proj', 'global'], 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0][0].source_id, taskBlobId);
  });
});

test('distill dry-run（无 sourceId 选项）也保留候选自带 source_id', async () => {
  await withEnv(async () => {
    const [cand] = taskRefluxCandidates([mkTask()]);
    assert.ok(cand.source_id, '前置：回流候选自带 source_id');
    const engine = new MemoryEngine(new FakeStore(), fakeEmbed);
    await distill(engine, [cand], { apply: false, sourceId: '' });
    assert.ok(cand.source_id, '自带值保留');
  });
});
