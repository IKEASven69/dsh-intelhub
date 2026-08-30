/**
 * Compile memories into agent-native markdown files.
 *
 * The coding-agent industry converged on plain markdown files that agents
 * auto-load (AGENTS.md, CLAUDE.md, .cursor/rules) — not vector databases —
 * for project memory. hippo compiles its structured store into those formats
 * so an agent "remembers" without anyone calling recall.
 *
 * Pure functions throughout: records in → markdown out, plus a filesystem
 * helper that idempotently injects a hippo-managed section into an existing
 * file (preserving any hand-written content outside the markers).
 *
 * Injection strategy is inferred from memory type (no schema change):
 *   decision / preference → always-on (project conventions, user prefs)
 *   fact                  → project-scoped (knowledge about a specific project)
 *   lesson                → on-demand (surface when relevant; Cursor uses
 *                            alwaysApply:false + description for this)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tasksForProject, type TaskRecord } from './task-context.js';
import type { MemoryRecord } from './memory.js';

export type CompileTarget = 'agents-md' | 'claude-md' | 'cursor' | 'copilot' | 'json' | 'all';
export const TARGETS: CompileTarget[] = ['agents-md', 'claude-md', 'cursor', 'copilot', 'json'];

/** Which injection bucket a memory falls into, based on its type. */
export type Strategy = 'always' | 'project' | 'on-demand';
export function strategyFor(type: string): Strategy {
  if (type === 'decision' || type === 'preference') return 'always';
  if (type === 'lesson') return 'on-demand';
  return 'project'; // fact + any future type default to project-scoped
}

export interface GroupedMemories {
  project?: string;               // compile 时传入（Current State 任务筛选用）
  always: MemoryRecord[];        // decisions + preferences, sorted by strength
  byProject: Map<string, MemoryRecord[]>; // facts keyed by project
  onDemand: MemoryRecord[];      // lessons
}

/** Filter + group memories into strategy buckets. Pure, no I/O. */
export function groupMemories(
  records: MemoryRecord[],
  opts: { project?: string; minStrength?: number } = {},
): GroupedMemories {
  let rs = records;
  if (opts.project) rs = rs.filter(r => r.project === opts.project);
  const minStr = opts.minStrength;
  if (minStr !== undefined) rs = rs.filter(r => r.strength >= minStr);

  const always: MemoryRecord[] = [];
  const byProject = new Map<string, MemoryRecord[]>();
  const onDemand: MemoryRecord[] = [];
  const result: GroupedMemories = { project: opts.project, always, byProject, onDemand };

  for (const r of rs) {
    const strat = strategyFor(r.type);
    if (strat === 'always') always.push(r);
    else if (strat === 'on-demand') onDemand.push(r);
    else (byProject.get(r.project) ?? byProject.set(r.project, []).get(r.project)!).push(r);
  }
  // Strength desc, then text for stable ordering.
  const cmp = (a: MemoryRecord, b: MemoryRecord) => b.strength - a.strength || a.text.localeCompare(b.text);
  always.sort(cmp);
  onDemand.sort(cmp);
  for (const list of byProject.values()) list.sort(cmp);
  return result;
}

// ── AGENTS.md / CLAUDE.md rendering ────────────────────────────────────────

const SECTION_START = '<!-- hippo:section-start (managed by `hippo compile`; edit memories via `hippo remember`, not this block) -->';
const SECTION_END = '<!-- hippo:section-end -->';

/** Render the grouped memories as the markdown body that goes between the
 * hippo section markers. Used by both agents-md and claude-md (same body,
 * different filename). */
export function renderAgentsMdBody(g: GroupedMemories): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);

  // Current State（操作性上下文：任务 + Context Protocol）——放在最前面
  lines.push(renderCurrentState(g.project ?? undefined));
  lines.push('');

  // Always-on conventions
  lines.push('## Conventions', '');
  if (g.always.length === 0) {
    lines.push('_(no conventions recorded yet — add with `hippo remember -t decision`)_', '');
  } else {
    for (const r of g.always) {
      const tag = r.type === 'preference' ? '[pref]' : '';
      const mark = r.strength > 1 ? ` (reinforced ×${r.strength.toFixed(0)})` : '';
      lines.push(`- ${tag}${r.text}${mark}`);
    }
    lines.push('');
  }

  // Project-scoped facts — latest-first: 近 7 天蒸馏的记忆标 ⭐ 置顶
  // （读 AGENTS.md 的 agent 最先看到"现在到哪了"），更早的沉淀跟后面。
  const projects = [...g.byProject.keys()].sort();
  const RECENT_MS = 7 * 86400 * 1000;
  for (const proj of projects) {
    lines.push(`## Project: ${proj}`, '');
    const list = g.byProject.get(proj)!.slice().sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    const recent = list.filter(r => Date.now() - (r.created_at ?? 0) * 1000 < RECENT_MS);
    const older = list.filter(r => !recent.includes(r));
    for (const r of recent) {
      const mark = r.strength > 1 ? ` (reinforced ×${r.strength.toFixed(0)})` : '';
      lines.push(`- ⭐ ${r.text}${mark}`);
    }
    for (const r of older) {
      const mark = r.strength > 1 ? ` (reinforced ×${r.strength.toFixed(0)})` : '';
      lines.push(`- ${r.text}${mark}`);
    }
    lines.push('');
  }

  // On-demand lessons (inline in AGENTS.md since it has no per-rule pull model;
  // agents reading AGENTS.md get everything. Cursor gets these as separate
  // alwaysApply:false files where the pull model exists.)
  if (g.onDemand.length > 0) {
    lines.push('## Lessons learned', '');
    for (const r of g.onDemand) {
      lines.push(`- ${r.text}`);
    }
    lines.push('');
  }

  lines.push(`_Compiled by hippo on ${date}._`);
  return lines.join('\n');
}

/** Wrap the rendered body in the hippo section markers. */
export function renderAgentsMd(g: GroupedMemories): string {
  return [SECTION_START, renderAgentsMdBody(g), SECTION_END].join('\n');
}

/** Current State 节（操作性上下文）：任务状态 + Context Protocol。
 * 告诉任何读到 AGENTS.md 的 AI agent（豆包/WorkBuddy/ChatGPT/任何工具）：
 * 完成重要讨论后把结论追加到本文件——上下文自动流转，零管道。 */
export function renderCurrentState(project?: string): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);
  lines.push('## Current State', '');

  // 任务状态
  if (project !== undefined && project !== '') {
    const tasks = tasksForProject(project);
    const open = tasks.filter(t => t.status !== 'completed');
    const done = tasks.filter(t => t.status === 'completed');
    if (open.length > 0) {
      lines.push('### Active Tasks');
      for (const t of open.slice(0, 10)) {
        lines.push(`- [${t.status === 'in_progress' ? '▶' : '○'}] ${t.text}${t.priority === 'high' ? ' ⚑' : ''}`);
      }
      lines.push('');
    }
    if (done.length > 0) {
      lines.push(`### Completed (${done.length})`);
      for (const t of done.slice(0, 5)) {
        lines.push(`- [✓] ${t.text}`);
      }
      if (done.length > 5) lines.push(`- … 共 ${done.length} 条已完成`);
      lines.push('');
    }
  }

  // Context Protocol（跨 agent 通信协议）
  lines.push('### 🦛 Context Protocol（给读到这段的任何 AI agent）');
  lines.push('');
  lines.push('与用户完成重要讨论/决策后，请把关键结论追加到本文件末尾，格式：');
  lines.push('- `[decision] 结论内容`');
  lines.push('- `[lesson] 踩坑教训`');
  lines.push('');
  lines.push('只追加，不删除已有内容。hippo 会定期整理这些条目。');
  lines.push('');
  lines.push(`_Current state compiled ${date}._`);
  return lines.join('\n');
}

/** 索引式编译正文（P1）：文件里只放每条记忆的一行索引（类型 + 截断摘要 + 日期），
 * 正文靠召回工具按需取——全文投影随记忆增长 token 必爆，索引式省一个量级。
 * 配套说明告诉 agent 用 memory_recall / `hippo recall` 取详情。 */
export function renderIndexMdBody(g: GroupedMemories): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);
  lines.push('## Memory index', '');
  lines.push('这是记忆库的**索引**（非全文）。需要某条的完整内容与上下文时，');
  lines.push('用 `memory_recall` 工具（或 `hippo recall "关键词"`）按语义检索，不要凭摘要行事。', '');

  const entry = (r: MemoryRecord) => {
    const ts = (r as { origin_ts?: number }).origin_ts && (r as { origin_ts?: number }).origin_ts! > 0
      ? (r as { origin_ts?: number }).origin_ts! : r.created_at;
    const d = new Date(ts * 1000).toISOString().slice(0, 10);
    const summary = r.text.length > 60 ? r.text.slice(0, 57) + '…' : r.text;
    return `- [${r.type}] ${summary}（${d}）`;
  };

  const sections: [string, MemoryRecord[]][] = [
    ['Conventions', g.always],
    ...[...g.byProject.keys()].sort().map((k) => [`Project: ${k}`, g.byProject.get(k)!] as [string, MemoryRecord[]]),
    ['Lessons', g.onDemand],
  ];
  for (const [title, list] of sections) {
    if (list.length === 0) continue;
    lines.push(`### ${title} (${list.length})`, '');
    for (const r of list) lines.push(entry(r));
    lines.push('');
  }
  lines.push(`_Index compiled by hippo on ${date}. Use memory_recall for full text._`);
  return lines.join('\n');
}

/** Wrap the index body in the same section markers. */
export function renderIndexMd(g: GroupedMemories): string {
  return [SECTION_START, renderIndexMdBody(g), SECTION_END].join('\n');
}

// ── idempotent file injection ──────────────────────────────────────────────

/** Read a file's existing content, or '' if missing. */
function readExisting(filePath: string): string {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''; }
  catch { return ''; }
}

/**
 * Merge a freshly-rendered hippo section into an existing file's content.
 *
 * - If the file already has hippo markers, replace what's between them.
 * - If it has no markers but has other content, append the section at the end
 *   (separated by a blank line) so hand-written content is preserved.
 * - If it doesn't exist, the section becomes the whole file.
 *
 * Returns the new file content. Pure (no I/O) — the caller writes it.
 */
export function injectSection(existing: string, section: string): string {
  const startIdx = existing.indexOf(SECTION_START);
  const endIdx = existing.indexOf(SECTION_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace the managed block; keep everything before start and after end.
    const after = existing.slice(endIdx + SECTION_END.length).replace(/^\n+/, '\n');
    return existing.slice(0, startIdx) + section + after;
  }
  if (existing.trim().length === 0) return section + '\n';
  // No markers yet but file has content — append.
  return existing.replace(/\n*$/, '\n\n') + section + '\n';
}

/** Write a compiled agents-md / claude-md file, merging with any existing
 * content via the marker section. Returns the path written (or '' for dry-run). */
/** 写入任意 section 内容（索引式编译用，与 writeAgentsMd 同一套合并逻辑）。 */
function writeSectionMd(outPath: string, section: string, dryRun?: boolean): string {
  const existing = readExisting(outPath);
  const merged = injectSection(existing, section);
  if (dryRun) return '';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, merged, 'utf-8');
  return outPath;
}

export function writeAgentsMd(
  outPath: string,
  groups: GroupedMemories,
  opts: { dryRun?: boolean } = {},
): string {
  const section = renderAgentsMd(groups);
  const existing = readExisting(outPath);
  const merged = injectSection(existing, section);
  if (opts.dryRun) return '';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, merged, 'utf-8');
  return outPath;
}

// ── Cursor .mdc rendering ──────────────────────────────────────────────────

interface CursorRule { filename: string; content: string; }

/** Render grouped memories as a set of Cursor rule files.
 *
 * Cursor's .mdc frontmatter has two relevant modes:
 *   alwaysApply: true   — injected into every request (conventions + prefs)
 *   alwaysApply: false  — pulled by the agent when its `description` matches
 *                         the current context (lessons)
 * Project-scoped facts go into the always-apply file under a project heading
 * (Cursor has no per-project rule scoping beyond globs; a single conventions
 * file is the common pattern).
 */
export function renderCursorRules(g: GroupedMemories): CursorRule[] {
  const rules: CursorRule[] = [];
  const date = new Date().toISOString().slice(0, 10);

  // Always-on conventions + project facts in one always-apply file.
  const body: string[] = [];
  if (g.always.length > 0) {
    body.push('## Conventions', '');
    for (const r of g.always) body.push(`- ${r.text}`);
    body.push('');
  }
  for (const proj of [...g.byProject.keys()].sort()) {
    body.push(`## Project: ${proj}`, '');
    for (const r of g.byProject.get(proj)!) body.push(`- ${r.text}`);
    body.push('');
  }
  if (body.length > 0) {
    body.push(`_Compiled by hippo on ${date}._`);
    rules.push({
      filename: 'hippo-conventions.mdc',
      content: [
        '---',
        'description: hippo-managed project conventions, preferences, and facts',
        'globs: "**/*"',
        'alwaysApply: true',
        '---',
        '',
        body.join('\n'),
      ].join('\n'),
    });
  }

  // Lessons as a separate on-demand file the agent pulls when relevant.
  if (g.onDemand.length > 0) {
    const lessonBody = g.onDemand.map(r => `- ${r.text}`).join('\n');
    rules.push({
      filename: 'hippo-lessons.mdc',
      content: [
        '---',
        'description: lessons learned on this project — failures, gotchas, and pitfalls to avoid',
        'globs: "**/*"',
        'alwaysApply: false',
        '---',
        '',
        lessonBody,
        '',
        `_Compiled by hippo on ${date}._`,
      ].join('\n'),
    });
  }

  return rules;
}

/** Write Cursor rule files into a rules directory. hippo owns the
 * `hippo-*.mdc` filenames; other rule files are left untouched. */
export function writeCursorRules(
  rulesDir: string,
  groups: GroupedMemories,
  opts: { dryRun?: boolean } = {},
): string[] {
  const rules = renderCursorRules(groups);
  const written: string[] = [];
  if (opts.dryRun) return rules.map(r => path.join(rulesDir, r.filename));
  fs.mkdirSync(rulesDir, { recursive: true });
  // Remove stale hippo-owned files first so a memory that's no longer present
  // doesn't linger as a stale rule.
  for (const f of fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir) : []) {
    if (f.startsWith('hippo-') && f.endsWith('.mdc')) {
      fs.rmSync(path.join(rulesDir, f), { force: true });
    }
  }
  for (const r of rules) {
    const p = path.join(rulesDir, r.filename);
    fs.writeFileSync(p, r.content, 'utf-8');
    written.push(p);
  }
  return written;
}

// ── top-level entry ────────────────────────────────────────────────────────

export interface CompileResult {
  target: CompileTarget;
  files: string[];   // paths written (or that would be written in dry-run)
  memoryCount: number;
}

/** Default output paths relative to the working directory. */
export function defaultOutPath(target: CompileTarget): string {
  if (target === 'agents-md') return 'AGENTS.md';
  if (target === 'claude-md') return 'CLAUDE.md';
  if (target === 'cursor') return path.join('.cursor', 'rules');
  if (target === 'copilot') return path.join('.github', 'copilot-instructions.md');
  if (target === 'json') return 'hippo-context.json';
  return ''; // 'all' is expanded by the caller
}

/**
 * Compile memories for a single target. `records` should already be filtered
 * by project/agent if desired (reuse exportRecords for that); this function
 * applies the strategy grouping and minStrength filter.
 */
export function compileTarget(
  target: CompileTarget,
  records: MemoryRecord[],
  opts: { outPath?: string; minStrength?: number; project?: string; dryRun?: boolean; indexMode?: boolean } = {},
): CompileResult {
  const groups = groupMemories(records, { project: opts.project, minStrength: opts.minStrength });
  const memoryCount = groups.always.length + groups.onDemand.length
    + [...groups.byProject.values()].reduce((s, l) => s + l.length, 0);
  const outPath = opts.outPath ?? defaultOutPath(target);

  let files: string[];
  if (target === 'agents-md' || target === 'claude-md' || target === 'copilot') {
    if (opts.indexMode) {
      files = [writeSectionMd(outPath, renderIndexMd(groups), opts.dryRun)].filter(Boolean);
    } else {
      files = [writeAgentsMd(outPath, groups, { dryRun: opts.dryRun })].filter(Boolean);
    }
    if (opts.dryRun) files = [outPath];
  } else if (target === 'json') {
    // JSON 格式：给程序化消费方（豆包 API / 自定义脚本）
    const output = {
      generatedAt: new Date().toISOString(),
      project: opts.project ?? 'global',
      currentState: {
        tasks: tasksForProject(opts.project ?? ''),
      },
      memories: {
        conventions: groups.always.map(r => ({ type: r.type, text: r.text, strength: r.strength })),
        projectFacts: Object.fromEntries([...groups.byProject.entries()].map(([k, v]) => [k, v.map(r => r.text)])),
        lessons: groups.onDemand.map(r => r.text),
      },
    };
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
    }
    files = [outPath];
  } else if (target === 'cursor') {
    files = writeCursorRules(outPath, groups, { dryRun: opts.dryRun });
  } else {
    files = [];
  }
  return { target, files, memoryCount };
}
