/**
 * src/patterns 的等价性测试 —— 用例 1:1 移植自 hippo tests/test_patterns.py。
 * 运行：npx tsx --test src/patterns/miner.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { entryToTurns, type Turn } from './transcript.js';
import {
  eventsFromTurns,
  findTranscripts,
  loadSessionEvents,
  makePattern,
  minePatterns,
  renderPattern,
  scorePatterns,
  signature,
  successRate,
  type ToolEvent,
} from './miner.js';

// ── 构造 Claude Code 格式的 transcript 条目 ────────

type Entry = Record<string, unknown>;

function toolUse(name: string, input: unknown, ts = '2026-08-01T00:00:01Z'): Entry {
  return {
    type: 'assistant',
    cwd: 'D:\\proj',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-x',
      content: [{ type: 'tool_use', name, input }],
    },
  };
}

function toolResult(text: string, failed = false, ts = '2026-08-01T00:00:02Z'): Entry {
  return {
    type: 'user',
    cwd: 'D:\\proj',
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: text, is_error: failed }],
    },
  };
}

function turns(...entries: Entry[]): Turn[] {
  return entries.flatMap(e => entryToTurns(e));
}

function ev(sig: string, opts: { failed?: boolean; ts?: number; tool?: string } = {}): ToolEvent {
  return {
    toolName: opts.tool ?? 'Bash',
    signature: sig,
    failed: opts.failed ?? false,
    ts: opts.ts ?? 0,
    summary: '',
  };
}

function session(...sigs: string[]): ToolEvent[] {
  return sigs.map(s => ev(s));
}

// ── 签名归一化 ─────────────────────────────────────

test('signature_bash_uses_command_head', () => {
  assert.equal(signature('Bash', 'git status'), 'Bash(git)');
  assert.equal(signature('Bash', 'pytest -x tests/'), 'Bash(pytest)');
});

test('signature_bash_strips_env_prefix_and_path', () => {
  assert.equal(signature('Bash', 'FOO=1 pytest tests/'), 'Bash(pytest)');
  assert.equal(signature('Bash', './scripts/deploy.sh --prod'), 'Bash(deploy.sh)');
});

test('signature_file_tools_use_extension', () => {
  assert.equal(signature('Edit', 'Edit: D:\\proj\\main.py'), 'Edit(.py)');
  assert.equal(signature('Read', 'Read: README.md'), 'Read(.md)');
  assert.equal(signature('Write', 'Write: no-extension-file'), 'Write');
});

test('signature_other_tools_pass_through', () => {
  assert.equal(signature('Grep', 'Grep: foo'), 'Grep');
  assert.equal(signature('Task', 'Task: explore'), 'Task');
});

// ── 事件提取（tool_use ↔ tool_result 配对）──────────

test('events_pair_results_with_calls', () => {
  const evs = eventsFromTurns(turns(
    toolUse('Bash', { command: 'pytest -x' }),
    toolResult('1 failed', true),
    toolUse('Read', { file_path: 'a.py' }),
    toolResult('ok'),
  ));
  assert.deepEqual(evs.map(e => e.signature), ['Bash(pytest)', 'Read(.py)']);
  assert.deepEqual(evs.map(e => e.failed), [true, false]);
});

test('events_multiple_calls_in_order', () => {
  const evs = eventsFromTurns(turns(
    {
      type: 'assistant',
      cwd: 'D:\\proj',
      timestamp: '2026-08-01T00:00:01Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'git add .' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'git commit' } },
        ],
      },
    },
    {
      type: 'user',
      cwd: 'D:\\proj',
      timestamp: '2026-08-01T00:00:02Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'ok', is_error: false },
          { type: 'tool_result', content: 'boom', is_error: true },
        ],
      },
    },
  ));
  assert.deepEqual(evs.map(e => e.signature), ['Bash(git)', 'Bash(git)']);
  assert.deepEqual(evs.map(e => e.failed), [false, true]);
});

test('events_unanswered_call_not_marked_failed', () => {
  const evs = eventsFromTurns(turns(toolUse('Bash', { command: 'make' })));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].failed, false);
});

// ── 挖掘 ──────────────────────────────────────────

function mapOf(obj: Record<string, ToolEvent[]>): Map<string, ToolEvent[]> {
  return new Map(Object.entries(obj));
}

test('mine_requires_cross_session_support', () => {
  // 一个会话里重复 5 次的模式，在 min_sessions=2 下必须被过滤
  const sessions = mapOf({ s1: session('A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B') });
  assert.deepEqual(minePatterns(sessions, { minSessions: 2, minCount: 3 }), []);
});

test('mine_drops_self_loops', () => {
  const sessions = mapOf({
    s1: session('Grep', 'Grep', 'Grep'),
    s2: session('Grep', 'Grep', 'Grep'),
    s3: session('Grep', 'Grep', 'Read(.py)', 'Grep'),
  });
  const pats = minePatterns(sessions, { minSessions: 2, minCount: 2 });
  assert.ok(pats.every(p => new Set(p.steps).size > 1));
});

test('mine_finds_recurring_workflow', () => {
  const sessions = mapOf({
    s1: session('Edit(.py)', 'Bash(pytest)', 'Bash(git)', 'Grep'),
    s2: session('Read(.py)', 'Edit(.py)', 'Bash(pytest)', 'Bash(git)'),
    s3: session('Edit(.py)', 'Bash(pytest)', 'Bash(git)'),
  });
  const pats = minePatterns(sessions, { minSessions: 2, minCount: 2 });
  const steps = new Set(pats.map(p => p.steps.join(',')));
  assert.ok(steps.has('Edit(.py),Bash(pytest),Bash(git)'));
  const pat = pats.find(p => p.steps.join(',') === 'Edit(.py),Bash(pytest),Bash(git)')!;
  assert.equal(pat.count, 3);
  assert.deepEqual([...pat.sessions].sort(), ['s1', 's2', 's3']);
  assert.equal(successRate(pat), 1.0);
});

test('mine_containment_dedup_drops_fragments', () => {
  const sessions = mapOf({
    s1: session('Edit(.py)', 'Bash(pytest)', 'Bash(git)'),
    s2: session('Edit(.py)', 'Bash(pytest)', 'Bash(git)'),
    s3: session('Edit(.py)', 'Bash(pytest)', 'Bash(git)'),
  });
  const pats = minePatterns(sessions, { minSessions: 2, minCount: 2 });
  assert.deepEqual(pats.map(p => p.steps.join(',')), ['Edit(.py),Bash(pytest),Bash(git)']);
});

test('mine_keeps_fragment_with_independent_support', () => {
  const sessions = mapOf({
    s1: session('Edit(.py)', 'Bash(pytest)', 'Bash(git)'),
    s2: session('Edit(.py)', 'Bash(pytest)', 'Bash(git)'),
    s3: session('Edit(.py)', 'Bash(pytest)', 'Grep'),
  });
  const pats = minePatterns(sessions, { minSessions: 2, minCount: 2 });
  const steps = new Set(pats.map(p => p.steps.join(',')));
  assert.ok(steps.has('Edit(.py),Bash(pytest)'));
  assert.ok(steps.has('Edit(.py),Bash(pytest),Bash(git)'));
});

test('mine_tracks_failures', () => {
  const bad = [ev('Edit(.py)'), ev('Bash(pytest)', { failed: true })];
  const good = [ev('Edit(.py)'), ev('Bash(pytest)')];
  const sessions = mapOf({ s1: bad, s2: good, s3: good });
  const pats = minePatterns(sessions, { minSessions: 2, minCount: 2 });
  assert.equal(pats[0].failures, 1);
  assert.ok(Math.abs(successRate(pats[0]) - 2 / 3) < 1e-9);
});

// ── 评分 ──────────────────────────────────────────

test('score_prefers_reliable_over_flaky', () => {
  const base = { count: 4, sessions: new Set(['s1', 's2']), lastSeen: 100.0 };
  const reliable: ReturnType<typeof makePattern> = { ...makePattern(['A', 'B']), ...base, failures: 0 };
  const flaky: ReturnType<typeof makePattern> = { ...makePattern(['C', 'D']), ...base, failures: 3 };
  const ranked = scorePatterns([flaky, reliable], 100.0);
  assert.equal(ranked[0], reliable);
  assert.ok(reliable.score > flaky.score);
});

test('score_recency_decays', () => {
  const fresh = { ...makePattern(['A', 'B']), count: 3, sessions: new Set(['s1', 's2']), lastSeen: 1000.0 };
  const stale = { ...makePattern(['C', 'D']), count: 3, sessions: new Set(['s1', 's2']), lastSeen: 0.0 };
  const ranked = scorePatterns([stale, fresh], 1000.0);
  assert.equal(ranked[0], fresh);
});

test('score_breadth_rewards_more_sessions', () => {
  const narrow = { ...makePattern(['A', 'B']), count: 4, sessions: new Set(['s1', 's2']), lastSeen: 5.0 };
  const wide = { ...makePattern(['C', 'D']), count: 4, sessions: new Set(['s1', 's2', 's3', 's4']), lastSeen: 5.0 };
  const ranked = scorePatterns([narrow, wide], 5.0);
  assert.equal(ranked[0], wide);
});

// ── 渲染 + IO ─────────────────────────────────────

test('render_pattern_shows_steps_and_stats', () => {
  const sessions = mapOf({
    s1: session('Edit(.py)', 'Bash(pytest)').map(e => ({ ...e, ts: 10 })),
    s2: session('Edit(.py)', 'Bash(pytest)').map(e => ({ ...e, ts: 20 })),
    s3: session('Edit(.py)', 'Bash(pytest)').map(e => ({ ...e, ts: 30 })),
  });
  const pat = minePatterns(sessions, { minSessions: 2, minCount: 2 })[0];
  scorePatterns([pat], 30.0);
  const text = renderPattern(pat);
  assert.ok(text.includes('Edit(.py) → Bash(pytest)'));
  assert.ok(text.includes('3x in 3 sessions'));
  assert.ok(text.includes('success 100%'));
});

test('load_session_events_roundtrip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ts-'));
  const entries = [toolUse('Bash', { command: 'pytest' }), toolResult('ok')];
  const p = path.join(dir, 'sess1.jsonl');
  fs.writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n'), 'utf-8');
  const events = loadSessionEvents(p);
  assert.deepEqual(events.map(e => e.signature), ['Bash(pytest)']);
  assert.ok(events[0].ts > 0); // 回退到文件 mtime
});

test('find_transcripts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ts-'));
  const proj = path.join(dir, '-D-proj');
  fs.mkdirSync(proj);
  const older = path.join(proj, 'a.jsonl');
  const newer = path.join(proj, 'b.jsonl');
  fs.writeFileSync(older, '{}', 'utf-8');
  fs.writeFileSync(newer, '{}', 'utf-8');
  fs.utimesSync(older, 1000, 1000);
  fs.utimesSync(newer, 2000, 2000);
  const files = findTranscripts(dir);
  assert.deepEqual(files.map(f => path.basename(f)), ['b.jsonl', 'a.jsonl']);
  assert.deepEqual(findTranscripts(dir, 1), [newer]);
  assert.deepEqual(findTranscripts(path.join(dir, 'nonexistent')), []);
});
