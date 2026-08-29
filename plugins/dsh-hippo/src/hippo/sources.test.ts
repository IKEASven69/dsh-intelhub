import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listSources, loadSource, MAX_SOURCE_TURNS, saveSource } from './sources.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-sources-'));
}

test('save/load roundtrip preserves the blob', () => {
  const dir = tmpDir();
  try {
    const turns = [
      { role: 'user', text: '你好', cwd: 'D:/p/x', ts: '2026-01-01T00:00:00Z', tool_name: '', tool_failed: false, model: '' },
      { role: 'assistant', text: '你好！', cwd: '', ts: '', tool_name: '', tool_failed: false, model: 'm' },
    ];
    const id = saveSource(turns, { project: 'x', agent: 'distill:claude', dataDir: dir });
    assert.ok(id);
    const blob = loadSource(id, { dataDir: dir });
    assert.ok(blob);
    assert.equal(blob!.source_id, id);
    assert.equal(blob!.project, 'x');
    assert.equal(blob!.agent, 'distill:claude');
    assert.equal(blob!.turn_count, 2);
    assert.equal(blob!.original_turn_count, 2);
    assert.equal(blob!.truncated, false);
    assert.equal(blob!.turns[0].text, '你好');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized transcripts are truncated and flagged', () => {
  const dir = tmpDir();
  try {
    const turns = Array.from({ length: MAX_SOURCE_TURNS + 50 }, (_, i) => ({ role: 'user', text: `t${i}` }));
    const id = saveSource(turns, { dataDir: dir });
    const blob = loadSource(id, { dataDir: dir })!;
    assert.equal(blob.turn_count, MAX_SOURCE_TURNS);
    assert.equal(blob.original_turn_count, MAX_SOURCE_TURNS + 50);
    assert.equal(blob.truncated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSource returns null for missing/empty ids', () => {
  const dir = tmpDir();
  try {
    assert.equal(loadSource('', { dataDir: dir }), null);
    assert.equal(loadSource('no-such-id', { dataDir: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSources returns metadata only, newest first, skips junk', () => {
  const dir = tmpDir();
  try {
    const a = saveSource([{ role: 'user', text: 'a' }], { project: 'pa', dataDir: dir });
    const b = saveSource([{ role: 'user', text: 'b' }], { project: 'pb', dataDir: dir });
    // corrupt + non-json files must be skipped silently
    fs.writeFileSync(path.join(dir, 'sources', 'junk.json'), 'not json', 'utf-8');
    fs.writeFileSync(path.join(dir, 'sources', 'note.txt'), 'hello', 'utf-8');

    const metas = listSources({ dataDir: dir });
    assert.equal(metas.length, 2);
    assert.deepEqual(metas.map(m => m.source_id).sort(), [a, b].sort());
    assert.ok(metas[0].saved_at >= metas[1].saved_at);
    assert.ok(!('turns' in metas[0]), 'metadata only');
    assert.equal(metas.find(m => m.source_id === a)!.project, 'pa');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
