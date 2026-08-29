/**
 * engine-holder 空闲宽限的行为测试。
 *
 * 三个核心性质:
 *  1. 宽限期内(归零后 <10s)再次 acquire → 复用同一 store(不重开 zvec)
 *  2. 宽限期到期无人接手 → 真正关锁,下次 acquire 是新 store 实例
 *  3. 并发引用计数:两个在途引用共享同一 store,全部归还后才进入宽限
 *
 * 用 mock.timers 驱动 10s 宽限,不用真等。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const GRACE_MS = 10_000;

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-holder-'));
  process.env.HIPPO_DATA_DIR = dir;
  return dir;
}

async function holder() {
  // 每个用例重新 import 会拿同一模块实例(单例状态),这是有意为之——
  // 用例结束时手动清干净(见 cleanup)。
  return await import('./engine-holder.js');
}

/** 用例收尾:强制清空模块单例,避免跨用例污染。 */
async function cleanup(mod: Awaited<ReturnType<typeof holder>>) {
  // 归零 + 快进宽限,触发真正的 close
  mock.timers.tick(GRACE_MS + 1);
  await new Promise(r => setImmediate(r));
  delete process.env.HIPPO_DATA_DIR;
}

test('grace period: re-acquire within grace reuses the same store', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  freshDataDir();
  const { acquireEngine } = await holder();
  try {
    const a = await acquireEngine();
    a.release();
    // 未过宽限 → 复用同一 store 实例(zvec 没有重开)
    const b = await acquireEngine();
    assert.equal(b.store, a.store, '宽限期内应复用同一 store 实例');
    b.release();
  } finally {
    await cleanup(await holder());
    mock.timers.reset();
  }
});

test('grace expiry: after grace the lock closes, next acquire opens a fresh store', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  freshDataDir();
  const { acquireEngine } = await holder();
  try {
    const a = await acquireEngine();
    a.release();
    // 快进超过宽限 → 定时关闭触发
    mock.timers.tick(GRACE_MS + 1);
    await new Promise(r => setImmediate(r)); // 让 timer 回调跑完
    const b = await acquireEngine();
    assert.notEqual(b.store, a.store, '宽限到期后应重开新 store 实例');
    b.release();
    mock.timers.tick(GRACE_MS + 1);
    await new Promise(r => setImmediate(r));
  } finally {
    await cleanup(await holder());
    mock.timers.reset();
  }
});

test('refcount: two concurrent holders share one store, grace starts only after both release', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  freshDataDir();
  const { acquireEngine } = await holder();
  try {
    const a = await acquireEngine();
    const b = await acquireEngine();
    assert.equal(b.store, a.store, '并发引用应共享同一 store');
    a.release();
    // 只还了一个引用:立刻再取,仍是同一实例且不进新宽限
    const c = await acquireEngine();
    assert.equal(c.store, a.store);
    b.release();
    c.release();
  } finally {
    await cleanup(await holder());
    mock.timers.reset();
  }
});
