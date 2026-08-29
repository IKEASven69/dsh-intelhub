import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEDUP_THRESHOLD, GLOBAL_PROJECT, MemoryEngine, VALID_TYPES } from './memory.js';
import { fakeEmbed, FakeStore } from './test-helpers.js';

function makeEngine(): { engine: MemoryEngine; store: FakeStore } {
  const store = new FakeStore();
  return { engine: new MemoryEngine(store, fakeEmbed), store };
}

test('remember creates a new memory', async () => {
  const { engine, store } = makeEngine();
  const r = await engine.remember('使用 SQLite WAL 模式', { type: 'decision', project: 'proj-a' });
  assert.equal(r.status, 'created');
  assert.equal(store.rows.size, 1);
  const rec = [...store.rows.values()][0].record;
  assert.equal(rec.type, 'decision');
  assert.equal(rec.project, 'proj-a');
  assert.equal(rec.strength, 1.0);
  assert.equal(rec.source_id, '');
  assert.equal(rec.source_offset, -1.0);
});

test('remember rejects empty text and invalid type', async () => {
  const { engine } = makeEngine();
  await assert.rejects(() => engine.remember('   '), /empty/);
  await assert.rejects(() => engine.remember('x', { type: 'bogus' }), /type must be one of/);
  assert.equal(VALID_TYPES.length, 4);
});

test('remember near-duplicate reinforces instead of creating', async () => {
  const { engine, store } = makeEngine();
  const a = await engine.remember('数据库文件在 ~/.hippo 目录', { project: 'proj-a' });
  const b = await engine.remember('数据库文件在 ~/.hippo 目录', { project: 'proj-a' });
  assert.equal(b.status, 'reinforced');
  assert.equal(b.id, a.id);
  assert.equal(b.strength, 2.0);
  assert.equal(store.rows.size, 1);
  // reinforce touches with a strength update
  assert.ok(store.touches.some(t => t.id === a.id && t.strength === 2.0));
});

test('dedup is scoped: same text in another project creates a new row', async () => {
  const { engine, store } = makeEngine();
  await engine.remember('技术栈是 TypeScript', { project: 'proj-a' });
  const r = await engine.remember('技术栈是 TypeScript', { project: 'proj-b' });
  assert.equal(r.status, 'created');
  assert.equal(store.rows.size, 2);
});

test('recall returns ranked hits and falls back to global scope', async () => {
  const { engine } = makeEngine();
  await engine.remember('端口是 3456', { type: 'fact', project: 'proj-a' });
  await engine.remember('全局偏好：总是使用 pnpm', { type: 'preference', project: GLOBAL_PROJECT });
  await engine.remember('完全不相关的另一条 zzz qqq', { project: 'proj-b' });

  // project-scoped recall sees proj-a + global, not proj-b
  const hits = await engine.recall('端口是 3456', { project: 'proj-a', limit: 5 });
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].text, '端口是 3456');
  assert.ok(hits.every(h => h.project === 'proj-a' || h.project === GLOBAL_PROJECT));
  assert.ok(hits[0].similarity > 0.99);

  // global recall only sees global
  const globalHits = await engine.recall('端口', { project: GLOBAL_PROJECT, limit: 5 });
  assert.ok(globalHits.every(h => h.project === GLOBAL_PROJECT));
});

test('recall touches accessed_at on returned hits only', async () => {
  const { engine, store } = makeEngine();
  const r1 = await engine.remember('入口是 src/index.ts', { project: 'proj-a' });
  await engine.remember('完全不同的内容 bbbb cccc dddd', { project: 'proj-a' });
  store.touches.length = 0;
  const hits = await engine.recall('入口是 src/index.ts', { project: 'proj-a', limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(store.touches.length, 1);
  assert.equal(store.touches[0].id, r1.id);
  assert.equal(store.touches[0].strength, undefined); // plain touch, no strength
});

test('recall strength boost lifts reinforced memories', async () => {
  const { engine } = makeEngine();
  // Two memories with equal similarity to the query (both share 2 of 3
  // tokens); reinforcing one must lift its final score above the other.
  const weak = await engine.remember('alpha beta', { project: 'proj-a' });
  const strong = await engine.remember('beta gamma', { project: 'proj-a' });
  for (let i = 0; i < 9; i++) {
    await engine.remember('beta gamma', { project: 'proj-a' }); // strength 10
  }
  const hits = await engine.recall('alpha beta gamma', { project: 'proj-a', limit: 5 });
  const strongHit = hits.find(h => h.id === strong.id)!;
  const weakHit = hits.find(h => h.id === weak.id)!;
  assert.ok(strongHit.similarity === weakHit.similarity, 'fixture: equal similarity');
  assert.ok(strongHit.score > weakHit.score, `strength boost should lift: ${strongHit.score} vs ${weakHit.score}`);
});

test('update edits text (re-embeds), type, project; preserves strength', async () => {
  const { engine, store } = makeEngine();
  const r = await engine.remember('旧内容 old content', { project: 'proj-a' });
  await engine.remember('旧内容 old content', { project: 'proj-a' }); // strength 2

  const u = await engine.update(r.id, { text: '新内容 new content', type: 'lesson', project: 'proj-b' });
  assert.equal(u.status, 'updated');
  const rec = store.rows.get(r.id)!.record;
  assert.equal(rec.text, '新内容 new content');
  assert.equal(rec.type, 'lesson');
  assert.equal(rec.project, 'proj-b');
  assert.equal(rec.strength, 2.0);

  await assert.rejects(() => engine.update(r.id, { text: '  ' }), /empty/);
  await assert.rejects(() => engine.update(r.id, { type: 'bogus' }), /type must be/);
  const missing = await engine.update('no-such-id', { text: 'x' });
  assert.equal(missing.status, 'not_found');
});

test('forget deletes and reports missing ids', async () => {
  const { engine, store } = makeEngine();
  const r = await engine.remember('要被删除的记忆', {});
  assert.equal(await engine.forget(r.id), true);
  assert.equal(store.rows.size, 0);
  assert.equal(await engine.forget(r.id), false);
});

test('threshold constant is exported for distill bands', () => {
  assert.equal(typeof DEDUP_THRESHOLD, 'number');
  assert.ok(DEDUP_THRESHOLD > 0.5 && DEDUP_THRESHOLD <= 1.0);
});
