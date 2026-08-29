import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { distill, DEDUP_MAYBE, DEDUP_REINFORCE, SUPERSEDE_FLOOR, extractCandidates, makeCandidate, MAX_CANDIDATES, type Candidate } from './distill.js';
import { MemoryEngine, type SearchHit, type Store } from './memory.js';
import { makeTurn } from '../patterns/transcript.js';
import { fakeEmbed, FakeStore } from './test-helpers.js';
import { loadSource } from './sources.js';

// ── rule extraction ───────────────────────────────

test('extracts decision / lesson / preference / fact by rules', () => {
  const turns = [
    makeTurn({ role: 'user', text: '我们决定用 SQLite 而不是 zvec。', cwd: 'D:/proj/hippo' }),
    makeTurn({ role: 'assistant', text: '根因是 vec0 的锁只授予一个进程。' }),
    makeTurn({ role: 'user', text: '以后都用 pnpm 跑脚本。' }),
    makeTurn({ role: 'assistant', text: '端口是 3456。' }),
  ];
  const cands = extractCandidates(turns);
  const byType = new Map(cands.map(c => [c.type, c]));
  assert.equal(byType.get('decision')?.text, '我们决定用 SQLite 而不是 zvec');
  assert.equal(byType.get('lesson')?.text, '根因是 vec0 的锁只授予一个进程');
  assert.equal(byType.get('preference')?.text, '以后都用 pnpm 跑脚本');
  assert.equal(byType.get('fact')?.text, '端口是 3456');
  assert.equal(byType.get('decision')?.project, 'hippo'); // from cwd basename
});

test('remember-trigger boosts confidence', () => {
  const plain = extractCandidates([makeTurn({ role: 'user', text: '决定用 A 方案。' })]);
  const boosted = extractCandidates([makeTurn({ role: 'user', text: '记住：决定用 A 方案。' })]);
  assert.equal(plain[0].confidence, 0.7);
  assert.equal(boosted[0].confidence, 0.95);
});

test('failed tool turn becomes a lesson candidate', () => {
  const turns = [
    makeTurn({ role: 'assistant', text: 'npm test', toolName: 'Bash' }),
    makeTurn({ role: 'tool', text: 'Error: boom', toolFailed: true }),
  ];
  const cands = extractCandidates(turns);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].type, 'lesson');
  assert.equal(cands[0].source_rule, 'tool_failed');
  assert.ok(cands[0].text.startsWith('操作失败: '));
});

test('one type per sentence, dedup by text, cap at MAX_CANDIDATES', () => {
  // A sentence matching both preference and decision keeps the first rule.
  const cands = extractCandidates([makeTurn({ role: 'user', text: '以后都决定用 pnpm。' })]);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].type, 'preference'); // first matching rule wins

  // Cap: 30 distinct decision sentences → MAX_CANDIDATES kept.
  const many = Array.from({ length: 30 }, (_, i) =>
    makeTurn({ role: 'user', text: `决定用方案编号${i}来处理这件事。` }));
  assert.equal(extractCandidates(many).length, MAX_CANDIDATES);
});

test('project override forces every candidate project', () => {
  const cands = extractCandidates(
    [makeTurn({ role: 'user', text: '决定用 X。', cwd: 'D:/a/b' })],
    { projectOverride: 'forced' },
  );
  assert.equal(cands[0].project, 'forced');
});

// ── dedup bands + apply ───────────────────────────

/** Engine stub whose store returns a scripted similarity for the next search. */
function scriptedEngine(sim: number): { engine: MemoryEngine; store: FakeStore } {
  const store = new FakeStore();
  if (sim > 0) {
    // Seed one row so search() returns a hit with the scripted similarity:
    // build a vector that yields exactly `sim` against any normalized query
    // is overkill — instead override search directly.
    store.search = (): Promise<SearchHit[]> =>
      Promise.resolve([[{
        id: 'existing', text: 'existing memory', type: 'fact',
        project: 'global', agent: 'test', created_at: 0, accessed_at: 0,
        strength: 1, source_id: '', source_offset: -1,
      }, sim]]);
  }
  return { engine: new MemoryEngine(store, fakeEmbed), store };
}

test('distill classifies candidates into reinforce/maybe/new bands', async () => {
  for (const [sim, expected] of [
    [DEDUP_REINFORCE, 'reinforce'],
    [DEDUP_MAYBE, 'maybe'],
    [DEDUP_MAYBE - 0.01, 'new'],
  ] as const) {
    const { engine } = scriptedEngine(sim);
    const cand = makeCandidate({ text: 'x', type: 'fact', project: 'global', confidence: 0.7, source_rule: 'fact' });
    const result = await distill(engine, [cand]);
    assert.equal(cand.duplicate, expected, `sim=${sim}`);
    assert.equal(cand.similarity, sim);
    assert.equal(result.created, 0); // dry-run writes nothing
  }
});

test('distill apply: new created, reinforce reinforced, maybe never auto-merged', async () => {
  // Real engine over a fake store: seed an existing memory so the identical
  // candidate reinforces (sim 1.0 >= REINFORCE), a distinct one is new.
  const store = new FakeStore();
  const engine = new MemoryEngine(store, fakeEmbed);
  await engine.remember('端口是 3456', { type: 'fact' });

  const same = makeCandidate({ text: '端口是 3456', type: 'fact', project: 'global', confidence: 0.7, source_rule: 'fact' });
  const fresh = makeCandidate({ text: '技术栈是 TypeScript', type: 'fact', project: 'global', confidence: 0.7, source_rule: 'fact' });
  const result = await distill(engine, [same, fresh], { apply: true });
  assert.equal(same.duplicate, 'reinforce');
  assert.equal(fresh.duplicate, 'new');
  assert.equal(result.created, 1);
  assert.equal(result.reinforced, 1);
  assert.equal(result.maybe, 0);
  assert.equal(store.rows.size, 2); // seed reinforced in place + fresh created

  // Maybe band: seed a partially-overlapping memory so sim lands in the band.
  const store2 = new FakeStore();
  const engine2 = new MemoryEngine(store2, fakeEmbed);
  const near = makeCandidate({ text: 'alpha beta gamma delta', type: 'fact', project: 'global', confidence: 0.7, source_rule: 'fact' });
  // craft similarity inside [MAYBE, REINFORCE) by embedding overlap
  await engine2.remember('alpha beta gamma epsilon zeta', { type: 'fact' });
  const result2 = await distill(engine2, [near], { apply: true });
  assert.ok(near.similarity >= 0 && near.similarity < DEDUP_REINFORCE);
  if (near.duplicate === 'maybe') {
    assert.equal(result2.maybe, 1);
    assert.equal(result2.created, 0);
    assert.equal(store2.rows.size, 1); // not written
  }
});

test('distill saves one L0 blob and links candidates via source_id', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-distill-'));
  try {
    const store = new FakeStore();
    const engine = new MemoryEngine(store, fakeEmbed);
    const turns = [makeTurn({ role: 'user', text: '决定用 SQLite。' })];
    const cand = makeCandidate({
      text: '决定用 SQLite', type: 'decision', project: 'global',
      confidence: 0.7, source_rule: 'decision', source_offset: 0,
    });
    await distill(engine, [cand], { apply: true, turns, dataDir: tmp });

    assert.ok(cand.source_id, 'candidate should carry source_id');
    const blob = loadSource(cand.source_id, { dataDir: tmp });
    assert.ok(blob);
    assert.equal(blob!.turn_count, 1);
    assert.equal(blob!.turns[0].text, '决定用 SQLite。');
    // applied memory carries provenance
    const rec = [...store.rows.values()][0].record;
    assert.equal(rec.source_id, cand.source_id);
    assert.equal(rec.source_offset, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('candidates satisfy the Candidate shape', () => {
  const c: Candidate = makeCandidate({ text: 't', type: 'fact', project: 'p', confidence: 0.5, source_rule: 'fact' });
  assert.deepEqual(
    { duplicate: c.duplicate, similarity: c.similarity, source_offset: c.source_offset, source_id: c.source_id },
    { duplicate: '', similarity: 0, source_offset: -1, source_id: '' },
  );
});

// ── 推翻链（双时态演化）───────────────────────────

test('decision flip with language evidence supersedes the old decision', async () => {
  // 词袋嵌入：7/8 token 重叠 → cos≈0.875，落在推翻带 [0.7, 0.93)
  const store = new FakeStore();
  const engine = new MemoryEngine(store, fakeEmbed);
  const seeded = await engine.remember('decided use pnpm for deps alpha beta gamma delta epsilon', { type: 'decision' });
  assert.equal(seeded.status, 'created');
  const oldId = seeded.id!;

  const flip = makeCandidate({ text: 'decided use pnpm for deps alpha beta gamma delta switch to', type: 'decision', project: 'global', confidence: 0.7, source_rule: 'decision' });
  const result = await distill(engine, [flip], { apply: true });
  assert.equal(flip.duplicate, 'supersede');
  assert.ok(flip.similarity >= SUPERSEDE_FLOOR && flip.similarity < DEDUP_REINFORCE, `sim=${flip.similarity}`);
  assert.equal(result.created, 1);
  // 旧版被标记取代、保留不删
  const old = await store.get(oldId);
  assert.ok(old, 'old record kept');
  assert.ok(old[0].superseded_by, 'superseded_by set');
});

test('fact at the same similarity stays maybe (supersede only for decisions)', async () => {
  const store = new FakeStore();
  const engine = new MemoryEngine(store, fakeEmbed);
  await engine.remember('the port number alpha beta gamma delta epsilon', { type: 'fact' });
  const near = makeCandidate({ text: 'the port number alpha beta gamma delta zeta', type: 'fact', project: 'global', confidence: 0.7, source_rule: 'fact' });
  const result = await distill(engine, [near], { apply: true });
  assert.ok(near.similarity >= SUPERSEDE_FLOOR && near.similarity < DEDUP_REINFORCE, `sim=${near.similarity}`);
  assert.equal(near.duplicate, 'maybe');
  assert.equal(result.maybe, 1);
});

test('superseded memories are downweighted in recall', async () => {
  const store = new FakeStore();
  const engine = new MemoryEngine(store, fakeEmbed);
  const a = await engine.remember('use kafka for events streaming alpha', { type: 'decision' });
  const b = await engine.remember('use rabbitmq for events streaming alpha', { type: 'decision' });
  await engine.markSuperseded(a.id!, b.id!);
  const hits = await engine.recall('use kafka for events streaming alpha', { limit: 5 });
  // 两条都可能在结果里，但被取代的 a 分数必须低于现行版 b
  const ha = hits.find(h => h.id === a.id);
  const hb = hits.find(h => h.id === b.id);
  if (ha && hb) assert.ok(ha.score < hb.score, `superseded (${ha.score}) should score below active (${hb.score})`);
});
