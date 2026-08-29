/**
 * Synthesize SKILL.md drafts from mined workflow Patterns.
 * TS port of hippo sop.py; consumes the spike's Pattern type from
 * src/patterns/miner.ts.
 *
 * `patterns` mines *that* a tool sequence recurs; this module turns the top
 * candidates into reviewable Claude Code skill drafts (<name>/SKILL.md).
 * Same constraint as the rest of hippo: pure rules, zero LLM — the input is
 * already normalized (signatures + raw one-line summaries), so templated
 * rendering covers it without inventing semantics we cannot know.
 *
 * Deliberate limitations, kept honest rather than papered over:
 * - The miner records *what* happened, not *why*. The generated "when to use"
 *   text is a mechanical description of the step sequence plus observed
 *   stats, not a real intent statement. A human must review and rewrite it.
 * - Steps are generalized (absolute paths collapse to "the target file",
 *   only the basename is kept as an example) so a draft never hardcodes one
 *   project's layout into a reusable skill.
 * - Pattern.examples carry no per-occurrence failure flags, so pitfalls
 *   cannot pinpoint *which* step failed — only that the workflow failed N of
 *   M times. Low success rates surface as a warning instead.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { successRate, type Pattern } from '../patterns/miner.js';

// ---------------------------------------------------------------------------
// Tuning knobs.
// ---------------------------------------------------------------------------
export const MAX_NAME_LEN = 40; // Claude Code skill names should stay short
export const LOW_CONFIDENCE = 0.8; // below this success rate, attach a warning

// Human names for the file extensions signatures keep.
const EXT_KIND: Record<string, string> = {
  '.py': 'Python',
  '.md': 'Markdown',
  '.js': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.jsx': 'JavaScript',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.sh': 'shell',
  '.html': 'HTML',
  '.css': 'CSS',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.sql': 'SQL',
};

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];

// Looks-like-an-absolute-path: drive letters, UNC, leading / or ~. Examples
// matching this are dropped from step text — a skill must not hardcode one
// project's layout.
const ABS_PATH_RE = /([A-Za-z]:[\\/])|(^|[\s'"])(\/|~[/\\]|\\\\)/;

/** A structured skill draft synthesized from one Pattern. */
export interface Sop {
  name: string; // kebab-case slug, e.g. "edit-py-then-pytest"
  trigger: string; // when-to-use sentence with observed stats
  steps: string[]; // human-readable instructions
  pitfalls: string[]; // empty when none observed
  confidence_note: string; // warning text, empty when success rate is fine
}

// ---------------------------------------------------------------------------
// Naming.
// ---------------------------------------------------------------------------

/** kebab-case a token: lowercase, non-alnum runs become single dashes. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/** "Edit(.py)" → ["Edit", ".py"]; "Grep" → ["Grep", ""]. */
function splitSignature(sig: string): [string, string] {
  const m = /^(\w+)(?:\((.*)\))?$/.exec(sig);
  if (!m) return [sig, ''];
  return [m[1], m[2] ?? ''];
}

/** One signature → one name token, e.g. "Edit(.py)" → "edit-py". */
function stepToken(sig: string): string {
  const [tool, inner] = splitSignature(sig);
  if (inner) {
    if (SHELL_TOOLS.includes(tool)) return slug(inner) || tool.toLowerCase();
    // File tools sign with the extension: "edit-py", "write-md".
    return slug(`${tool}-${inner.replace(/^\./, '')}`);
  }
  return slug(tool);
}

/** Join step tokens into a readable slug, truncated to MAX_NAME_LEN.
 * Truncation cuts back to a token boundary so the name never ends mid-word
 * ("edit-py-then-pyt" → "edit-py"); only a single over-long first token is
 * hard-truncated. */
function nameFor(steps: string[]): string {
  const name = steps.map(stepToken).join('-then-');
  if (name.length <= MAX_NAME_LEN) return name;
  let cut = name.slice(0, MAX_NAME_LEN);
  if (cut.includes('-')) cut = cut.slice(0, cut.lastIndexOf('-'));
  return cut.replace(/-+$/, '') || name.slice(0, MAX_NAME_LEN).replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// Step rendering.
// ---------------------------------------------------------------------------

function extKind(inner: string): string {
  return EXT_KIND[inner] ?? (inner.replace(/^\./, '') || 'target');
}

/** Basename of the path in a file-tool summary ("Edit: D:\p\main.py" → "main.py").
 * Returns '' when the example holds no usable path. */
function exampleBasename(example: string): string {
  const text = example.includes(':') ? example.slice(example.indexOf(':') + 1).trim() : example.trim();
  return text.split(/[/\\]/).pop()!.trim();
}

/** Keep a command example only when it carries no absolute path. */
function shellExample(example: string, head: string): string {
  if (!example || !example.startsWith(head)) return '';
  if (ABS_PATH_RE.test(example)) return '';
  return example;
}

/** One signature (+ optional raw example) → one imperative instruction. */
function stepInstruction(sig: string, example: string): string {
  const [tool, inner] = splitSignature(sig);
  if (SHELL_TOOLS.includes(tool) && inner) {
    if (inner === 'git') return 'Run the git command';
    const extra = shellExample(example, inner);
    if (extra && extra !== inner) return `Run \`${extra}\``;
    return `Run \`${inner}\``;
  }
  if (FILE_TOOLS.includes(tool)) {
    const kind = inner ? extKind(inner) : 'target';
    const verb: Record<string, string> = {
      Read: 'Read', Edit: 'Edit', Write: 'Write', NotebookEdit: 'Edit the notebook cell in',
    };
    const v = verb[tool] ?? tool;
    const base = example ? exampleBasename(example) : '';
    if (base) return `${v} the target ${kind} file (e.g. \`${base}\`)`;
    return `${v} the target ${kind} file`;
  }
  const fallback: Record<string, string> = {
    Grep: 'Search the codebase (Grep)',
    Glob: 'Find files (Glob)',
    Task: 'Delegate to a subagent (Task)',
  };
  return fallback[tool] ?? `Use ${tool}`;
}

/** Gerund phrase for the trigger sentence, e.g. "editing Python files". */
function stepAction(sig: string): string {
  const [tool, inner] = splitSignature(sig);
  if (SHELL_TOOLS.includes(tool) && inner) {
    if (inner === 'git') return 'running git commands';
    return `running \`${inner}\``;
  }
  if (FILE_TOOLS.includes(tool)) {
    const kind = inner ? extKind(inner) : 'target';
    const verb: Record<string, string> = {
      Read: 'reading', Edit: 'editing', Write: 'writing', NotebookEdit: 'editing',
    };
    return `${verb[tool] ?? tool.toLowerCase()} ${kind} files`;
  }
  return `using ${tool}`;
}

// ---------------------------------------------------------------------------
// Synthesis.
// ---------------------------------------------------------------------------

/** Turn one mined Pattern into a structured skill draft. The first recorded
 * example feeds step phrasing; everything specific to one machine — absolute
 * paths, drive letters — is generalized away. */
export function synthesizeSop(pattern: Pattern): Sop {
  const name = nameFor(pattern.steps);
  const example = pattern.examples.length ? pattern.examples[0] : [];

  const actions = pattern.steps.map(stepAction);
  const when = actions.length === 1
    ? `When ${actions[0]}`
    : `When ${actions[0]} followed by ${actions.slice(1).join(', then ')}`;
  const nSessions = pattern.sessions.size;
  const rate = successRate(pattern);
  const trigger =
    `${when} — seen ${pattern.count}x across ${nSessions} ` +
    `session${nSessions !== 1 ? 's' : ''} (${(rate * 100).toFixed(0)}% success)`;

  const steps = pattern.steps.map((sig, i) => stepInstruction(sig, i < example.length ? example[i] : ''));

  const pitfalls: string[] = [];
  if (pattern.failures) {
    pitfalls.push(
      `This workflow failed ${pattern.failures} of ${pattern.count} observed runs. ` +
      `The miner records which *occurrence* failed, not which step — re-run the ` +
      `steps once before trusting them.`,
    );
  }

  let confidenceNote = '';
  if (rate < LOW_CONFIDENCE) {
    confidenceNote =
      `Low confidence: success rate ${(rate * 100).toFixed(0)}% ` +
      `(${pattern.failures}/${pattern.count} runs had a failed step). ` +
      `Treat this draft as a starting point, not a proven procedure.`;
  }

  return { name, trigger, steps, pitfalls, confidence_note: confidenceNote };
}

// ---------------------------------------------------------------------------
// Rendering + export.
// ---------------------------------------------------------------------------

/** Double-quote a scalar for YAML (frontmatter has exactly two fields). */
function yamlQuote(text: string): string {
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Render a Sop as a Claude Code SKILL.md (YAML frontmatter + 3 sections). */
export function renderSkillMd(sop: Sop): string {
  const lines = [
    '---',
    `name: ${sop.name}`,
    `description: ${yamlQuote(sop.trigger)}`,
    '---',
    '',
    '## When to use',
    '',
    sop.trigger,
    '',
    '## Steps',
    '',
  ];
  sop.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push('', '## Pitfalls', '');
  if (sop.pitfalls.length) {
    for (const p of sop.pitfalls) lines.push(`- ${p}`);
  } else {
    lines.push('- None observed in the mined sessions.');
  }
  if (sop.confidence_note) {
    lines.push('', `> **Note:** ${sop.confidence_note}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Write the top-N patterns as <outDir>/<name>/SKILL.md drafts.
 * Assumes `patterns` is already ranked (scorePatterns order). Slug
 * collisions (two patterns truncating to the same name) get a numeric
 * suffix rather than silently overwriting each other. */
export function exportSkills(patterns: Pattern[], outDir: string, opts: { top?: number } = {}): string[] {
  const top = opts.top ?? 5;
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const used = new Set<string>();
  for (const pattern of patterns.slice(0, top)) {
    const sop = synthesizeSop(pattern);
    let name = sop.name;
    let n = 2;
    while (used.has(name)) {
      name = `${sop.name}-${n}`;
      n += 1;
    }
    used.add(name);
    const skillDir = path.join(outDir, name);
    fs.mkdirSync(skillDir, { recursive: true });
    const p = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(p, renderSkillMd(sop), 'utf-8');
    written.push(p);
  }
  return written;
}
