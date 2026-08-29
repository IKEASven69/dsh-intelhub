import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exportSkills, renderSkillMd, synthesizeSop } from './sop.js';
import { makePattern, type Pattern } from '../patterns/miner.js';

function patternFixture(overrides: Partial<Pattern> = {}): Pattern {
  const p = makePattern(['Edit(.py)', 'Bash(pytest)']);
  p.count = 5;
  p.sessions = new Set(['s1', 's2', 's3']);
  p.failures = 0;
  p.examples = [['Edit: D:\\coding\\proj\\main.py', 'pytest tests/ -x']];
  return Object.assign(p, overrides);
}

test('synthesizeSop names patterns as kebab slugs with -then-', () => {
  const sop = synthesizeSop(patternFixture());
  assert.equal(sop.name, 'edit-py-then-pytest');
});

test('trigger sentence carries count, sessions and success rate', () => {
  const sop = synthesizeSop(patternFixture());
  assert.match(sop.trigger, /^When editing Python files followed by running `pytest`/);
  assert.match(sop.trigger, /seen 5x across 3 sessions \(100% success\)$/);
});

test('steps generalize absolute paths but keep basename examples', () => {
  const sop = synthesizeSop(patternFixture());
  assert.equal(sop.steps[0], 'Edit the target Python file (e.g. `main.py`)');
  // shell example has no absolute path → kept verbatim
  assert.equal(sop.steps[1], 'Run `pytest tests/ -x`');
});

test('shell examples with absolute paths are dropped to the bare head', () => {
  const p = patternFixture({ examples: [['Edit: src/a.py', 'pytest D:\\coding\\proj\\tests -x']] });
  const sop = synthesizeSop(p);
  assert.equal(sop.steps[1], 'Run `pytest`');
});

test('git commands get a generic instruction', () => {
  const p = patternFixture({ steps: ['Bash(git)'], examples: [['git status']] });
  const sop = synthesizeSop(p);
  assert.equal(sop.steps[0], 'Run the git command');
});

test('long names truncate at a token boundary', () => {
  const p = patternFixture({
    steps: ['Edit(.typescriptreact)', 'Bash(jest)', 'Read(.md)', 'Write(.json)'],
  });
  const sop = synthesizeSop(p);
  assert.ok(sop.name.length <= 40, sop.name);
  assert.ok(!sop.name.endsWith('-'));
  // Matches the Python algorithm exactly: cut to 40 chars, then back to the
  // last dash — which can leave a dangling "-then" (a known Python quirk).
  assert.equal(sop.name, 'edit-typescriptreact-then-jest-then');
});

test('failures produce a pitfall; low success adds a confidence note', () => {
  const sop = synthesizeSop(patternFixture({ failures: 3 })); // 2/5 = 40% success
  assert.equal(sop.pitfalls.length, 1);
  assert.match(sop.pitfalls[0], /failed 3 of 5 observed runs/);
  assert.match(sop.confidence_note, /Low confidence: success rate 40%/);
});

test('clean pattern has no pitfalls and no confidence note', () => {
  const sop = synthesizeSop(patternFixture());
  assert.equal(sop.pitfalls.length, 0);
  assert.equal(sop.confidence_note, '');
});

test('renderSkillMd emits frontmatter and three sections', () => {
  const md = renderSkillMd(synthesizeSop(patternFixture({ failures: 1 })));
  assert.match(md, /^---\nname: edit-py-then-pytest\n/);
  assert.match(md, /description: "When editing Python files/);
  assert.ok(md.includes('## When to use'));
  assert.ok(md.includes('## Steps'));
  assert.ok(md.includes('1. Edit the target Python file'));
  assert.ok(md.includes('## Pitfalls'));
  assert.match(md, /- This workflow failed 1 of 5/);
});

test('renderSkillMd writes the no-pitfalls placeholder', () => {
  const md = renderSkillMd(synthesizeSop(patternFixture()));
  assert.ok(md.includes('- None observed in the mined sessions.'));
});

test('exportSkills writes <name>/SKILL.md and suffixes slug collisions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-sop-'));
  try {
    // Two patterns whose names collide after truncation.
    const a = patternFixture();
    const b = patternFixture({ steps: ['Edit(.py)', 'Bash(pytest)'], sessions: new Set(['s9']) });
    const c = patternFixture({ steps: ['Grep', 'Read(.ts)'], count: 4 });
    const written = exportSkills([a, b, c], tmp, { top: 3 });
    assert.equal(written.length, 3);
    const names = written.map(p => path.basename(path.dirname(p)));
    assert.equal(new Set(names).size, 3, 'collision must get a numeric suffix');
    assert.ok(names.includes('edit-py-then-pytest'));
    assert.ok(names.includes('edit-py-then-pytest-2'));
    for (const p of written) {
      assert.ok(fs.readFileSync(p, 'utf-8').startsWith('---\n'));
      assert.equal(path.basename(p), 'SKILL.md');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
