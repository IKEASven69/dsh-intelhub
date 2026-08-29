import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbedModelMismatch, SqliteStore } from './store.js';
import type { MemoryRecord } from './memory.js';

const DIM = 8;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-store-'));
}

function rec(id: string, text: string, project = 'global'): MemoryRecord {
  return {
    id, text, type: 'fact', project, agent: 'test',
    created_at: 1000, accessed_at: 1000, strength: 1,
    source_id: '', source_offset: -1,
  };
}

/** Unit vector with 1.0 at dim i — orthogonal vectors for exact sims. */
function unitVec(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i % DIM] = 1.0;
  return v;
}

test('upsert/search roundtrip: identical vector has similarity ~1', async () => {
  const dir = tmpDir();
  const store = new SqliteStore(dir, DIM);
  try {
    await store.upsert(rec('a', '记忆 A'), unitVec(0));
    await store.upsert(rec('b', '记忆 B'), unitVec(1));
    const hits = await store.search(unitVec(0), ['global'], 10);
    assert.equal(hits.length, 2);
    assert.equal(hits[0][0].id, 'a');
    assert.ok(Math.abs(hits[0][1] - 1.0) < 1e-5, `sim=${hits[0][1]}`);
    assert.ok(Math.abs(hits[1][1]) < 1e-3, 'orthogonal vector ~ 0');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search filters by project scope', async () => {
  const dir = tmpDir();
  const store = new SqliteStore(dir, DIM);
  try {
    await store.upsert(rec('a', 'alpha', 'proj-a'), unitVec(0));
    await store.upsert(rec('g', 'gamma', 'global'), unitVec(0));
    await store.upsert(rec('b', 'beta', 'proj-b'), unitVec(0));

    const projA = await store.search(unitVec(0), ['proj-a', 'global'], 10);
    assert.deepEqual(projA.map(([r]) => r.id).sort(), ['a', 'g']);

    const globalOnly = await store.search(unitVec(0), ['global'], 10);
    assert.deepEqual(globalOnly.map(([r]) => r.id), ['g']);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsert replaces text and vector on conflict', async () => {
  const dir = tmpDir();
  const store = new SqliteStore(dir, DIM);
  try {
    await store.upsert(rec('a', 'old text'), unitVec(0));
    await store.upsert({ ...rec('a', 'new text'), strength: 3 }, unitVec(1));
    const got = await store.get('a');
    assert.ok(got);
    assert.equal(got![0].text, 'new text');
    assert.equal(got![0].strength, 3);
    assert.equal(store.count(), 1);
    // vector was replaced: searching dim-1 now hits with sim ~1
    const hits = await store.search(unitVec(1), ['global'], 1);
    assert.ok(Math.abs(hits[0][1] - 1.0) < 1e-5);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delete removes row and vector; get returns null after', async () => {
  const dir = tmpDir();
  const store = new SqliteStore(dir, DIM);
  try {
    await store.upsert(rec('a', 'alpha'), unitVec(0));
    assert.equal(await store.delete('a'), true);
    assert.equal(await store.delete('a'), false);
    assert.equal(await store.get('a'), null);
    assert.equal((await store.search(unitVec(0), ['global'], 10)).length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('touch updates accessed_at and optionally strength', async () => {
  const dir = tmpDir();
  const store = new SqliteStore(dir, DIM);
  try {
    await store.upsert(rec('a', 'alpha'), unitVec(0));
    await store.touch('a', { accessedAt: 2000 });
    assert.equal((await store.get('a'))![0].accessed_at, 2000);
    assert.equal((await store.get('a'))![0].strength, 1);
    await store.touch('a', { accessedAt: 3000, strength: 5 });
    const r = (await store.get('a'))![0];
    assert.equal(r.accessed_at, 3000);
    assert.equal(r.strength, 5);
    // touching a missing id is a no-op, not an error
    await store.touch('missing', { accessedAt: 1 });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scan returns every record; count matches', async () => {
  const dir = tmpDir();
  const store = new SqliteStore(dir, DIM);
  try {
    for (let i = 0; i < 5; i++) await store.upsert(rec(`id-${i}`, `text ${i}`), unitVec(i));
    const all = store.scan() as [MemoryRecord, number][];
    assert.equal(all.length, 5);
    assert.equal(store.count(), 5);
    assert.ok(all.every(([, sim]) => sim === 0.0));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hybridSearch fuses FTS + vector and normalizes top score to 1', async () => {
  const dir = tmpDir();
  const store = new SqliteStore(dir, DIM);
  try {
    await store.upsert(rec('a', 'sqlite wal mode rocks', 'proj-a'), unitVec(0));
    await store.upsert(rec('b', 'unrelated content here', 'proj-a'), unitVec(1));
    const hits = await store.hybridSearch!('sqlite wal', unitVec(0), ['proj-a'], 10);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0][0].id, 'a'); // top in both lanes
    assert.ok(Math.abs(hits[0][1] - 1.0) < 1e-9, 'top RRF score normalized to 1');
    // project filter still applies
    const none = await store.hybridSearch!('sqlite wal', unitVec(0), ['proj-b'], 10);
    assert.equal(none.length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dimension mismatch on reopen raises EmbedModelMismatch', async () => {
  const dir = tmpDir();
  const store = new SqliteStore(dir, DIM);
  await store.upsert(rec('a', 'alpha'), unitVec(0));
  store.close();
  try {
    assert.throws(() => new SqliteStore(dir, DIM * 2), EmbedModelMismatch);
    // reopening with the same dim is fine
    const again = new SqliteStore(dir, DIM);
    assert.equal(again.count(), 1);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
