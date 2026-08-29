/**
 * Tests for compile.ts — strategy grouping, markdown rendering, idempotent
 * section injection, and cursor rule generation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  strategyFor, groupMemories, renderAgentsMd, renderAgentsMdBody,
  renderCursorRules, injectSection, writeAgentsMd, writeCursorRules,
  compileTarget, defaultOutPath,
} from './compile.js';
import type { MemoryRecord } from './memory.js';

function mem(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'id' + Math.random().toString(36).slice(2, 8),
    text: 'x', type: 'fact', project: 'global', agent: 'test',
    created_at: 1000, accessed_at: 1000, strength: 1,
    source_id: '', source_offset: -1,
    ...over,
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-compile-'));
}

// ── strategy inference ─────────────────────────────────────────────────────

test('strategyFor maps types to buckets', () => {
  assert.equal(strategyFor('decision'), 'always');
  assert.equal(strategyFor('preference'), 'always');
  assert.equal(strategyFor('lesson'), 'on-demand');
  assert.equal(strategyFor('fact'), 'project');
  // unknown future type defaults to project-scoped
  assert.equal(strategyFor('custom'), 'project');
});

// ── grouping ───────────────────────────────────────────────────────────────

test('groupMemories splits by strategy and sorts by strength', () => {
  const recs = [
    mem({ text: 'd1', type: 'decision', strength: 1 }),
    mem({ text: 'd2', type: 'decision', strength: 3 }),
    mem({ text: 'p1', type: 'preference', strength: 1 }),
    mem({ text: 'f1', type: 'fact', project: 'hippo', strength: 1 }),
    mem({ text: 'f2', type: 'fact', project: 'hippo', strength: 2 }),
    mem({ text: 'f3', type: 'fact', project: 'blindspot', strength: 1 }),
    mem({ text: 'l1', type: 'lesson', strength: 1 }),
  ];
  const g = groupMemories(recs);
  assert.equal(g.always.length, 3);
  assert.equal(g.onDemand.length, 1);
  assert.deepEqual([...g.byProject.keys()].sort(), ['blindspot', 'hippo']);
  // strength desc within a bucket
  assert.equal(g.always[0].text, 'd2');
  assert.equal(g.byProject.get('hippo')![0].text, 'f2');
});

test('groupMemories filters by project and minStrength', () => {
  const recs = [
    mem({ text: 'a', type: 'fact', project: 'hippo', strength: 1 }),
    mem({ text: 'b', type: 'fact', project: 'hippo', strength: 5 }),
    mem({ text: 'c', type: 'fact', project: 'other', strength: 5 }),
  ];
  assert.equal(groupMemories(recs, { project: 'hippo' }).byProject.get('hippo')!.length, 2);
  assert.equal(groupMemories(recs, { minStrength: 5 }).byProject.size, 2);
  assert.equal(groupMemories(recs, { project: 'hippo', minStrength: 5 }).byProject.get('hippo')!.length, 1);
});

// ── AGENTS.md rendering ────────────────────────────────────────────────────

test('renderAgentsMdBody has conventions then projects then lessons', () => {
  const g = groupMemories([
    mem({ text: 'use pnpm', type: 'decision' }),
    mem({ text: '中文优先', type: 'preference' }),
    mem({ text: 'store=zvec', type: 'fact', project: 'hippo' }),
    mem({ text: 'lock bug', type: 'lesson' }),
  ]);
  const body = renderAgentsMdBody(g);
  const convIdx = body.indexOf('## Conventions');
  const projIdx = body.indexOf('## Project: hippo');
  const lessonIdx = body.indexOf('## Lessons learned');
  assert.ok(convIdx >= 0 && projIdx > convIdx && lessonIdx > projIdx, 'sections in wrong order');
  assert.ok(body.includes('- use pnpm'));
  assert.ok(body.includes('- store=zvec'));
  assert.ok(body.includes('- lock bug'));
});

test('renderAgentsMd wraps body in section markers', () => {
  const out = renderAgentsMd(groupMemories([mem({ type: 'decision', text: 'x' })]));
  assert.ok(out.includes('<!-- hippo:section-start'));
  assert.ok(out.includes('<!-- hippo:section-end'));
  // markers appear exactly once each
  assert.equal(out.split('hippo:section-start').length - 1, 1);
  assert.equal(out.split('hippo:section-end').length - 1, 1);
});

test('renderAgentsMdBody handles empty store without crashing', () => {
  const body = renderAgentsMdBody(groupMemories([]));
  assert.ok(body.includes('## Conventions'));
  assert.ok(body.includes('no conventions recorded'));
});

// ── idempotent injection ───────────────────────────────────────────────────

test('injectSection appends when no markers exist', () => {
  const existing = '# My Notes\n\nhand-written content\n';
  const section = renderAgentsMd(groupMemories([mem({ type: 'decision', text: 'use pnpm' })]));
  const merged = injectSection(existing, section);
  assert.ok(merged.includes('hand-written content'));
  assert.ok(merged.includes('hippo:section-start'));
  // hand-written content comes before the hippo block
  assert.ok(merged.indexOf('hand-written') < merged.indexOf('hippo:section-start'));
});

test('injectSection replaces existing marker block, preserves outside content', () => {
  const before = '# Header\n\nhand-written\n';
  const oldSection = renderAgentsMd(groupMemories([mem({ type: 'decision', text: 'OLD' })]));
  const after = '# Footer\n';
  const existing = before + '\n' + oldSection + '\n' + after;
  const newSection = renderAgentsMd(groupMemories([mem({ type: 'decision', text: 'NEW' })]));
  const merged = injectSection(existing, newSection);
  assert.ok(merged.includes('hand-written'), 'before-block content preserved');
  assert.ok(merged.includes('Footer'), 'after-block content preserved');
  assert.ok(merged.includes('NEW'), 'new content present');
  assert.ok(!merged.includes('OLD'), 'old managed content replaced');
  // exactly one marker pair
  assert.equal(merged.split('hippo:section-start').length - 1, 1);
});

test('writeAgentsMd roundtrips: write twice, second replaces not duplicates', () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'AGENTS.md');
    writeAgentsMd(p, groupMemories([mem({ type: 'decision', text: 'first' })]));
    const first = fs.readFileSync(p, 'utf-8');
    writeAgentsMd(p, groupMemories([mem({ type: 'decision', text: 'second' })]));
    const second = fs.readFileSync(p, 'utf-8');
    assert.ok(!second.includes('first'));
    assert.ok(second.includes('second'));
    assert.equal(second.split('hippo:section-start').length - 1, 1, 'no duplicate marker');
    void first;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* EPERM on Windows tmp */ }
  }
});

// ── cursor rules ───────────────────────────────────────────────────────────

test('renderCursorRules emits always-apply conventions file + on-demand lessons file', () => {
  const rules = renderCursorRules(groupMemories([
    mem({ text: 'use pnpm', type: 'decision' }),
    mem({ text: 'store=zvec', type: 'fact', project: 'hippo' }),
    mem({ text: 'lock bug', type: 'lesson' }),
  ]));
  const names = rules.map(r => r.filename).sort();
  assert.deepEqual(names, ['hippo-conventions.mdc', 'hippo-lessons.mdc']);
  const conv = rules.find(r => r.filename === 'hippo-conventions.mdc')!;
  assert.ok(conv.content.includes('alwaysApply: true'));
  assert.ok(conv.content.includes('use pnpm'));
  assert.ok(conv.content.includes('Project: hippo'));
  const lessons = rules.find(r => r.filename === 'hippo-lessons.mdc')!;
  assert.ok(lessons.content.includes('alwaysApply: false'));
  assert.ok(lessons.content.includes('description:'));
  assert.ok(lessons.content.includes('lock bug'));
});

test('renderCursorRules omits lessons file when there are no lessons', () => {
  const rules = renderCursorRules(groupMemories([mem({ type: 'decision', text: 'x' })]));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].filename, 'hippo-conventions.mdc');
});

test('writeCursorRules removes stale hippo files', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    // pre-create a stale hippo rule that should be cleaned (no lesson anymore)
    fs.writeFileSync(path.join(dir, 'hippo-lessons.mdc'), 'stale');
    fs.writeFileSync(path.join(dir, 'user-rule.mdc'), 'keep me');
    writeCursorRules(dir, groupMemories([mem({ type: 'decision', text: 'x' })]));
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['hippo-conventions.mdc', 'user-rule.mdc'], 'stale hippo file removed, user file kept');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* EPERM */ }
  }
});

// ── dry-run ────────────────────────────────────────────────────────────────

test('compileTarget dry-run writes nothing', () => {
  const dir = tmpDir();
  try {
    const out = path.join(dir, 'AGENTS.md');
    compileTarget('agents-md', [mem({ type: 'decision', text: 'x' })], { outPath: out, dryRun: true });
    assert.ok(!fs.existsSync(out), 'dry-run must not write the file');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* EPERM */ }
  }
});

// ── default paths ──────────────────────────────────────────────────────────

test('defaultOutPath maps targets to conventional paths', () => {
  assert.equal(defaultOutPath('agents-md'), 'AGENTS.md');
  assert.equal(defaultOutPath('claude-md'), 'CLAUDE.md');
  assert.equal(defaultOutPath('cursor'), path.join('.cursor', 'rules'));
});
