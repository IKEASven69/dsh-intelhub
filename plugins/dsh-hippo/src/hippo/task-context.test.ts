/**
 * task-context M1 测试：TodoWrite 提取回归 + git 维度采集（branch/changed）+
 * 非 git 目录静默降级 + 新字段 JSON 往返。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractTasksFromTurns, collectGitContext, saveTasks, loadTasks, mergeTasks,
  loadStore, saveStore, mergeStoreTasks, taskHistory,
  type TaskRecord, type TasksStoreV2,
} from './task-context.js';
import { renderCurrentState, renderIndexMdBody, compileTarget } from './compile.js';
import { makeTurn } from '../patterns/transcript.js';

// ── 夹具 ──────────────────────────────────────────

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 建一个带一次 commit 的临时 git 仓库，返回目录。 */
function tmpGitRepo(prefix: string): string {
  const dir = tmpDir(prefix);
  const run = (args: string) =>
    execSync(`git ${args}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
  run('init');
  // 独立身份，不依赖全局 git config
  run('-c user.name=t -c user.email=t@t commit --allow-empty -m init');
  return dir;
}

function withEnv(fn: () => void): void {
  const dir = tmpDir('hippo-task-');
  const prev = process.env.HIPPO_DATA_DIR;
  process.env.HIPPO_DATA_DIR = dir;
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env.HIPPO_DATA_DIR; else process.env.HIPPO_DATA_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* EPERM on win */ }
  }
}

function todoTurn(todos: Array<{ content: string; status: string; priority?: string }>, ts = '2026-09-01T10:00:00Z') {
  return makeTurn({ role: 'assistant', text: JSON.stringify({ todos }), ts, toolName: 'TodoWrite' });
}

// ── 提取回归（既有行为不破坏）─────────────────────

test('extractTasksFromTurns: 提取最新 TodoWrite 快照', () => {
  const turns = [
    todoTurn([{ content: '旧任务', status: 'pending' }], '2026-09-01T09:00:00Z'),
    todoTurn([
      { content: '任务A', status: 'in_progress', priority: 'high' },
      { content: '任务B', status: 'completed', priority: 'low' },
    ]),
  ];
  const tasks = extractTasksFromTurns(turns, 's1', 'proj');
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].text, '任务A');
  assert.equal(tasks[0].status, 'in_progress');
  assert.equal(tasks[0].priority, 'high');
  assert.equal(tasks[1].status, 'completed');
});

test('extractTasksFromTurns: 非 JSON / 空内容跳过', () => {
  const turns = [
    makeTurn({ role: 'assistant', text: 'not json', toolName: 'TodoWrite' }),
    todoTurn([{ content: '  ', status: 'pending' }]),
    todoTurn([{ content: '有效任务', status: 'pending' }]),
  ];
  const tasks = extractTasksFromTurns(turns, 's1', 'proj');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, '有效任务');
});

test('extractTasksFromTurns: zcode 拼接 text（input\\noutput）取首行解析', () => {
  // zcode.ts 把 tool text 组装为 "input\noutput"——output 是 {oldTodos:...}，
  // 整段 parse 失败，须退化为首行解析（存量 bug，M1 验收时发现并修复）
  const text = JSON.stringify({ todos: [{ content: 'zcode任务', status: 'in_progress' }] })
    + '\n' + JSON.stringify({ oldTodos: [{ content: '旧', status: 'pending' }] });
  const turns = [makeTurn({ role: 'tool', text, toolName: 'TodoWrite', ts: '2026-09-01T10:00:00Z' })];
  const tasks = extractTasksFromTurns(turns, 's1', 'proj');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, 'zcode任务');
  assert.equal(tasks[0].status, 'in_progress');
});

// ── git 维度采集（M1 核心）─────────────────────────

test('collectGitContext: git 仓库返回分支名', () => {
  const dir = tmpGitRepo('hippo-git-');
  try {
    const ctx = collectGitContext(dir);
    // 不硬编码默认分支名（init 默认 master/main 随 git 版本）
    assert.ok(ctx.branch, 'branch 应非空');
    assert.ok(['master', 'main'].includes(ctx.branch!) || ctx.branch!.length > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collectGitContext: status 含 untracked + 修改（M0 缺陷 #2 修复验证）', () => {
  const dir = tmpGitRepo('hippo-git-');
  try {
    // 已跟踪文件的修改
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v1\n');
    execSync('git add tracked.txt', { cwd: dir, stdio: 'ignore' });
    execSync('git -c user.name=t -c user.email=t@t commit -m add', { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2\n');
    // 未跟踪新文件——M0 实测 diff --stat 漏掉它，status --short 必须包含
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');

    const ctx = collectGitContext(dir);
    assert.ok(ctx.changed, 'changed 应非空');
    assert.ok(ctx.changed!.includes('untracked.txt'), `changed 应含 untracked，实际: ${ctx.changed}`);
    assert.ok(ctx.changed!.includes('tracked.txt'), `changed 应含修改文件，实际: ${ctx.changed}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collectGitContext: 非 git 目录静默降级返回空对象', () => {
  const dir = tmpDir('hippo-nogit-');
  try {
    const ctx = collectGitContext(dir);
    assert.deepEqual(ctx, {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collectGitContext: 空 cwd 返回空对象', () => {
  assert.deepEqual(collectGitContext(''), {});
});

// ── 字段往返（老数据兼容 + 新字段序列化）───────────

test('saveTasks/loadTasks: 新字段往返保留，老数据无字段兼容', () => {
  withEnv(() => {
    const git: TaskRecord = {
      project: 'proj', text: '带git', status: 'in_progress', priority: 'high',
      updatedAt: 1000, sessionId: 's1', branch: 'main', changed: ['a.ts', 'b.ts'],
    };
    const legacy: TaskRecord = {
      project: 'proj', text: '老数据', status: 'pending', priority: 'medium',
      updatedAt: 900, sessionId: 's0',
    };
    saveTasks([git, legacy]);
    const loaded = loadTasks();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].branch, 'main');
    assert.deepEqual(loaded[0].changed, ['a.ts', 'b.ts']);
    assert.equal(loaded[1].branch, undefined);
    assert.equal(loaded[1].changed, undefined);
    // mergeTasks 对新字段透明透传
    const merged = mergeTasks([], [git]);
    assert.equal(merged[0].branch, 'main');
  });
});

// ── 两层存储（M2）：活跃快照 + 历史归档 ────────────

function task(partial: Partial<TaskRecord> & { text: string }): TaskRecord {
  return {
    project: 'proj', status: 'completed', priority: 'medium',
    updatedAt: 1000, sessionId: 's1', ...partial,
  };
}

test('loadStore: 老格式（裸数组）自动迁移为 v2，历史层为空', () => {
  withEnv(() => {
    const old: TaskRecord[] = [task({ text: '老格式任务', status: 'pending' })];
    fs.writeFileSync(path.join(process.env.HIPPO_DATA_DIR!, 'tasks.json'), JSON.stringify(old));
    const store = loadStore();
    assert.equal(store.version, 2);
    assert.equal(store.active.length, 1);
    assert.equal(store.active[0].text, '老格式任务');
    assert.deepEqual(store.history, []);
    // loadTasks 对老格式语义不变
    assert.equal(loadTasks().length, 1);
  });
});

test('mergeStoreTasks: 快照中消失的任务归档进历史层（含 git 状态与完成时刻）', () => {
  withEnv(() => {
    const prev: TasksStoreV2 = {
      version: 2,
      active: [
        task({ text: '会消失的已完成', updatedAt: 2000, sessionId: 'sA', branch: 'feat-x', changed: ['a.ts'] }),
        task({ text: '仍活跃', status: 'in_progress', updatedAt: 2000, sessionId: 'sA' }),
      ],
      history: [],
    };
    const incoming: TaskRecord[] = [task({ text: '仍活跃', status: 'completed', updatedAt: 3000, sessionId: 'sA' })];
    const next = mergeStoreTasks(prev, incoming);
    // 活跃层：消失的没了，新快照替换
    assert.equal(next.active.length, 1);
    assert.equal(next.active[0].text, '仍活跃');
    // 历史层：消失任务带着完成时刻 + 当时 git 状态归档
    assert.equal(next.history.length, 1);
    assert.equal(next.history[0].text, '会消失的已完成');
    assert.equal(next.history[0].updatedAt, 2000);
    assert.equal(next.history[0].branch, 'feat-x');
    assert.deepEqual(next.history[0].changed, ['a.ts']);
  });
});

test('mergeStoreTasks: 归档 dedupe（同 project+sessionId+text 留最新），且不重复膨胀', () => {
  withEnv(() => {
    const mk = (updatedAt: number): TasksStoreV2 => ({
      version: 2,
      active: [task({ text: '反复出现', updatedAt })],
      history: [],
    });
    // 两次快照更替，同一任务消失两次（updatedAt 不同）
    const s1 = mergeStoreTasks(mk(1000), []); // incoming 空直接返回，另造
    void s1;
    const withTask = (t: TaskRecord): TaskRecord[] => [t];
    const step1 = mergeStoreTasks({
      version: 2,
      active: [task({ text: '反复出现', updatedAt: 1000 })],
      history: [],
    }, withTask(task({ text: '新任务', updatedAt: 2000, sessionId: 'sB' })));
    assert.equal(step1.history.length, 1);
    assert.equal(step1.history[0].updatedAt, 1000);
    // 又一轮：同文本任务再次消失——dedupe 后仍只 1 条，保留更晚的 updatedAt
    const step2 = mergeStoreTasks({
      version: 2,
      active: [task({ text: '反复出现', updatedAt: 5000 })],
      history: step1.history,
    }, withTask(task({ text: '另一新任务', updatedAt: 6000, sessionId: 'sC' })));
    const dup = step2.history.filter(h => h.text === '反复出现');
    assert.equal(dup.length, 1);
    assert.equal(dup[0].updatedAt, 5000);
  });
});

test('mergeStoreTasks: 历史层上限 2000（最旧的被裁掉）', () => {
  withEnv(() => {
    const history: TaskRecord[] = [];
    for (let i = 0; i < 2050; i++) {
      history.push(task({ text: `h-${i}`, updatedAt: i, sessionId: 's' + (i % 7) }));
    }
    const next = mergeStoreTasks({ version: 2, active: [], history }, [task({ text: '新', status: 'pending' })]);
    assert.equal(next.history.length, 2000);
    assert.equal(next.history.some(h => h.text === 'h-0'), false); // 最旧被裁
    assert.equal(next.history.some(h => h.text === 'h-2049'), true);
  });
});

test('taskHistory: 按项目查询，可选再按 sessionId 过滤', () => {
  withEnv(() => {
    saveStore({
      version: 2,
      active: [],
      history: [
        task({ text: 'p1的任务', project: 'p1', sessionId: 'sA' }),
        task({ text: 'p1的另一会话', project: 'p1', sessionId: 'sB' }),
        task({ text: 'p2的任务', project: 'p2', sessionId: 'sA' }),
      ],
    });
    assert.equal(taskHistory('p1').length, 2);
    assert.equal(taskHistory('p1', 'sA').length, 1);
    assert.equal(taskHistory('p1', 'sA')[0].text, 'p1的任务');
    assert.equal(taskHistory('p2').length, 1);
    assert.equal(taskHistory('nope').length, 0);
  });
});

test('saveTasks 写活跃层时保留既有历史层', () => {
  withEnv(() => {
    saveStore({
      version: 2,
      active: [],
      history: [task({ text: '历史一条' })],
    });
    saveTasks([task({ text: '活跃一条', status: 'pending' })]);
    const store = loadStore();
    assert.equal(store.active.length, 1);
    assert.equal(store.history.length, 1);
    assert.equal(store.history[0].text, '历史一条');
  });
});

// ── compile 投影硬约束（M2 × §5.2.2/§7.1.1）────────

test('compile 常驻投影：活跃层可见，历史层/归档产物永不泄漏', () => {
  withEnv(() => {
    saveStore({
      version: 2,
      active: [
        task({ text: '活跃任务甲', status: 'in_progress', priority: 'high' }),
        task({ text: '活跃任务乙', status: 'pending' }),
      ],
      history: [
        task({ text: '已归档的卡点任务', sessionId: 'sOLD', branch: 'dev', changed: ['x.ts'] }),
      ],
    });
    // 全量投影
    const full = renderCurrentState('proj');
    assert.ok(full.includes('活跃任务甲'));
    assert.ok(!full.includes('已归档的卡点任务'), '历史层不得进常驻投影');
    // 薄索引投影
    const idx = renderIndexMdBody({ project: 'proj', always: [], byProject: new Map(), onDemand: [] });
    assert.ok(idx.includes('活跃任务甲'));
    assert.ok(!idx.includes('已归档的卡点任务'), '历史层不得进薄索引');
  });
});

test('compile 默认 index 模式：产物是薄索引 + 薄 Current State，全量需显式 opt-in', () => {
  withEnv(() => {
    saveTasks([task({ text: '进行中的事', status: 'in_progress' })]);
    const out = path.join(process.env.HIPPO_DATA_DIR!, 'AGENTS.md');
    // 不传 indexMode → 默认走薄索引
    compileTarget('agents-md', [], { outPath: out, project: 'proj' });
    const written = fs.readFileSync(out, 'utf-8');
    assert.ok(written.includes('## Memory index'), '默认产物应是索引式');
    assert.ok(written.includes('进行中的事'), '薄索引应含活跃任务');
    assert.ok(!written.includes('### Active Tasks'), '全量 Current State 节不应出现在索引模式');
    // 显式 opt-in 全量
    compileTarget('agents-md', [], { outPath: out, project: 'proj', indexMode: false });
    const fullWritten = fs.readFileSync(out, 'utf-8');
    assert.ok(fullWritten.includes('## Conventions'), 'opt-in 后应是全量正文');
  });
});

test('薄索引 Current State：活跃任务最多 3 条 + 卡点（in_progress）置顶', () => {
  withEnv(() => {
    saveTasks([
      task({ text: '任务1', status: 'pending' }),
      task({ text: '任务2', status: 'in_progress' }),
      task({ text: '任务3', status: 'pending' }),
      task({ text: '任务4', status: 'pending' }),
      task({ text: '任务5', status: 'pending' }),
    ]);
    const idx = renderIndexMdBody({ project: 'proj', always: [], byProject: new Map(), onDemand: [] });
    assert.ok(idx.includes('**Current focus:** 任务2'), 'in_progress 应为卡点行');
    for (const t of ['任务1', '任务2', '任务3']) assert.ok(idx.includes(t));
    assert.ok(!idx.includes('任务4'), '薄索引只展示前 3 条');
    assert.ok(!idx.includes('任务5'));
  });
});
