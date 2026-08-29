import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryEngine } from './memory.js';
import { SqliteStore } from './store.js';
import { exportRecords, importJsonl, listRecords, renderMarkdown, writeJsonl } from './transfer.js';
import { fakeEmbed, FAKE_DIM } from './test-helpers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-transfer-'));
}

async function seededEngine(dir: string): Promise<{ engine: MemoryEngine; store: SqliteStore }> {
  const store = new SqliteStore(dir, FAKE_DIM);
  const engine = new MemoryEngine(store, fakeEmbed);
  await engine.remember('端口是 3456', { type: 'fact', project: 'proj-a', agent: 'claude', createdAt: 1000 });
  await engine.remember('决定用 SQLite', { type: 'decision', project: 'proj-a', agent: 'codex', createdAt: 2000 });
  await engine.remember('以后都用 pnpm', { type: 'preference', project: 'global', agent: 'claude', createdAt: 3000 });
  return { engine, store };
}

test('export → import roundtrip is idempotent (re-import reinforces)', async () => {
  const dir = tmpDir();
  const dir2 = tmpDir();
  try {
    const { store } = await seededEngine(dir);
    const jsonl = writeJsonl(exportRecords(store));
    store.close();

    // Import into a fresh store: all created.
    const store2 = new SqliteStore(dir2, FAKE_DIM);
    const engine2 = new MemoryEngine(store2, fakeEmbed);
    const counts = await importJsonl(engine2, jsonl);
    assert.deepEqual(counts, { created: 3, reinforced: 0, skipped: 0 });
    assert.equal(store2.count(), 3);

    // Re-importing the same file: everything reinforces, nothing created.
    const again = await importJsonl(engine2, jsonl);
    assert.deepEqual(again, { created: 0, reinforced: 3, skipped: 0 });
    assert.equal(store2.count(), 3);
    const strengths = (store2.scan() as [import('./memory.js').MemoryRecord, number][])
      .map(([r]) => r.strength);
    assert.ok(strengths.every(s => s === 2), 're-import reinforces strength');

    // created_at survives the roundtrip.
    const records = exportRecords(store2);
    assert.deepEqual(records.map(r => r.created_at), [1000, 2000, 3000]);
    store2.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows EPERM on tmp dirs */ }
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch { /* Windows EPERM on tmp dirs */ }
  }
});

test('export filters by project and agent, oldest first', async () => {
  const dir = tmpDir();
  try {
    const { store } = await seededEngine(dir);
    const projA = exportRecords(store, { project: 'proj-a' });
    assert.equal(projA.length, 2);
    assert.equal(projA[0].text, '端口是 3456'); // created_at 1000 first
    const claude = exportRecords(store, { agent: 'claude' });
    assert.equal(claude.length, 2);
    // export format: exactly the hippo JSONL fields, no vectors
    assert.deepEqual(Object.keys(projA[0]).sort(),
      ['accessed_at', 'agent', 'created_at', 'project', 'source_id', 'source_offset', 'strength', 'superseded_by', 'text', 'type']);
    store.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows EPERM on tmp dirs */ }
  }
});

test('listRecords filters, paginates, newest first, includes id', async () => {
  const dir = tmpDir();
  try {
    const { store } = await seededEngine(dir);
    const all = listRecords(store);
    assert.equal(all.length, 3);
    assert.equal(all[0].text, '以后都用 pnpm'); // newest first
    assert.ok(all[0].id);

    const page = listRecords(store, { limit: 1, offset: 1 });
    assert.equal(page.length, 1);
    assert.equal(page[0].text, '决定用 SQLite');

    assert.equal(listRecords(store, { type: 'decision' }).length, 1);
    assert.equal(listRecords(store, { project: 'global' }).length, 1);
    store.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows EPERM on tmp dirs */ }
  }
});

test('renderMarkdown groups by project with Chinese type tags', async () => {
  const dir = tmpDir();
  try {
    const { store } = await seededEngine(dir);
    const md = renderMarkdown(exportRecords(store));
    assert.ok(md.startsWith('# Memories (exported by hippo)'));
    assert.ok(md.includes('## global'));
    assert.ok(md.includes('## proj-a'));
    assert.ok(md.includes('- **[事实]** 端口是 3456'));
    assert.ok(md.includes('- **[决策]** 决定用 SQLite'));
    assert.ok(md.includes('- **[偏好]** 以后都用 pnpm'));
    store.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows EPERM on tmp dirs */ }
  }
});

test('importJsonl skips malformed lines and reports them', async () => {
  const dir = tmpDir();
  try {
    const store = new SqliteStore(dir, FAKE_DIM);
    const engine = new MemoryEngine(store, fakeEmbed);
    const counts = await importJsonl(engine, [
      '{"text":"ok one","type":"fact"}',
      'not json at all',
      '{"type":"fact"}', // missing text
      '',
      '{"text":"ok two"}',
    ].join('\n'));
    assert.deepEqual(counts, { created: 2, reinforced: 0, skipped: 2 });
    store.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows EPERM on tmp dirs */ }
  }
});
