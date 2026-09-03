#!/usr/bin/env node
/**
 * hippo memory engine CLI — TS port of hippo cli.py.
 *
 * Subcommands: remember / recall / update / forget / list / stats /
 * export / import / distill / patterns / serve (MCP stdio).
 *
 * The Python version's leader/follower forwarding is gone: SQLite WAL
 * allows a short-lived CLI process and a long-running MCP server to share
 * the store without a socket hop.
 */
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openEngine } from './engine.js';
import { VALID_TYPES } from './memory.js';
import { exportRecords, importJsonl, listRecords, renderMarkdown, writeJsonl } from './transfer.js';
import { compileTarget, TARGETS, type CompileTarget } from './compile.js';

const program = new Command();

program
  .name('hippo')
  .description('hippo memory engine (TypeScript)')
  .version('0.2.0');

// ── remember ──────────────────────────────────────

program
  .command('remember')
  .description('save a memory')
  .argument('<text>', 'memory text')
  .option('-t, --type <type>', `one of ${VALID_TYPES.join('/')}`, 'fact')
  .option('-p, --project <project>', 'project scope', 'global')
  .option('-a, --agent <agent>', 'attribution tag', 'cli')
  .action(async (text: string, options) => {
    const { engine, close } = openEngine();
    try {
      const r = await engine.remember(text, {
        type: options.type, project: options.project, agent: options.agent,
      });
      if (r.status === 'rejected') {
        console.error(`❌ 已拒绝入库：疑似敏感信息（${r.reason}）。密钥不应进入记忆库。`);
        process.exitCode = 1;
      } else {
        console.log(r.status === 'reinforced'
          ? `reinforced ${r.id} (strength ${r.strength})`
          : `created ${r.id}`);
      }
    } finally {
      close();
    }
  });

// ── recall ────────────────────────────────────────

program
  .command('recall')
  .description('semantic search of memories')
  .argument('<query>', 'natural-language query')
  .option('-p, --project <project>', 'scope (default global)', 'global')
  .option('-n, --limit <number>', 'max results', '5')
  .action(async (query: string, options) => {
    const { engine, close } = openEngine();
    try {
      const hits = await engine.recall(query, {
        project: options.project, limit: Number(options.limit),
      });
      if (!hits.length) {
        console.log('(no matches)');
        return;
      }
      for (const h of hits) {
        console.log(`[${h.score.toFixed(2)} ${h.similarity.toFixed(2)} ${h.type}] ${h.text}`);
        console.log(`  id=${h.id} project=${h.project}`);
      }
    } finally {
      close();
    }
  });

// ── update ────────────────────────────────────────

program
  .command('update')
  .description('edit an existing memory in place (preserves strength)')
  .argument('<id>', 'memory id')
  .option('--text <text>', 'new text (re-embeds)')
  .option('-t, --type <type>', `one of ${VALID_TYPES.join('/')}`)
  .option('-p, --project <project>', 'new project scope')
  .action(async (id: string, options) => {
    const { engine, close } = openEngine();
    try {
      const fields: { text?: string; type?: string; project?: string } = {};
      if (options.text !== undefined) fields.text = options.text;
      if (options.type !== undefined) fields.type = options.type;
      if (options.project !== undefined) fields.project = options.project;
      const r = await engine.update(id, fields);
      console.log(r.status === 'updated' ? `updated ${id}` : `not found: ${id}`);
    } finally {
      close();
    }
  });

// ── forget ────────────────────────────────────────

program
  .command('forget')
  .description('delete a memory by id')
  .argument('<id>', 'memory id')
  .action(async (id: string) => {
    const { engine, close } = openEngine();
    try {
      const deleted = await engine.forget(id);
      console.log(deleted ? `deleted ${id}` : `not found: ${id}`);
    } finally {
      close();
    }
  });

// ── list ──────────────────────────────────────────

program
  .command('list')
  .description('list memories (filtered, newest first)')
  .option('-p, --project <project>', 'filter by project')
  .option('-t, --type <type>', `filter by type (${VALID_TYPES.join('/')})`)
  .option('-a, --agent <agent>', 'filter by agent')
  .option('-n, --limit <number>', 'page size', '50')
  .option('--offset <number>', 'skip first N', '0')
  .action((options) => {
    const { store, close } = openEngine();
    try {
      const records = listRecords(store, {
        project: options.project, type: options.type, agent: options.agent,
        limit: Number(options.limit), offset: Number(options.offset),
      });
      if (!records.length) {
        console.log('(no memories)');
        return;
      }
      for (const r of records) {
        const strength = Number(r.strength ?? 1);
        const mark = strength > 1 ? ` x${strength}` : '';
        console.log(`[${r.type}|${r.project}${mark}] ${r.text}`);
        console.log(`  id=${String(r.id).slice(0, 12)}... created=${Number(r.created_at).toFixed(0)}`);
      }
    } finally {
      close();
    }
  });

// ── stats ─────────────────────────────────────────

program
  .command('sleep')
  .description('睡眠整合：合并近重复记忆（sim≥0.95）、回收孤儿 L0 源（移入 sources.trash）、清过期搁置候选')
  .option('--apply', '执行（默认只出报告）')
  .action(async (options) => {
    const { engine, close } = openEngine();
    const { runSleep } = await import('./sleep.js');
    try {
      const r = await runSleep(engine, { apply: options.apply === true });
      console.log(`近重复簇: ${r.dupClusters.length}${options.apply ? `（已合并 ${r.merged}）` : ''}`);
      for (const c of r.dupClusters.slice(0, 10)) {
        console.log(`  [${c.similarity.toFixed(3)}] keep(强度${c.keep.strength}): ${c.keep.text.slice(0, 50)}`);
        for (const d of c.drop) console.log(`         drop(强度${d.strength}): ${d.text.slice(0, 50)}`);
      }
      console.log(`孤儿源: ${r.orphanSources.length}${options.apply ? `（已移入回收站 ${r.orphanSourcesDeleted}）` : ''}`);
      console.log(`过期搁置: ${r.staleShelvedDropped}${options.apply ? '（已清）' : ''}`);
      if (!options.apply) console.log('加 --apply 执行。孤儿源移入 sources.trash，可手动捞回。');
    } finally { close(); }
  })

  .command('stats')
  .description('print counts by project and type')
  .action(() => {
    const { store, close } = openEngine();
    try {
      const records = (store.scan() as [import('./memory.js').MemoryRecord, number][]).map(([r]) => r);
      const byProject = new Map<string, number>();
      const byType = new Map<string, number>();
      for (const r of records) {
        byProject.set(r.project, (byProject.get(r.project) ?? 0) + 1);
        byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
      }
      console.log(`total: ${records.length}`);
      for (const [name, counts] of [['projects', byProject], ['types', byType]] as const) {
        console.log(`${name}:`);
        for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${k.padEnd(20)} ${v}`);
        }
      }
    } finally {
      close();
    }
  });

// ── export ────────────────────────────────────────

program
  .command('export')
  .description('export memories (jsonl or markdown)')
  .option('-p, --project <project>', 'only this project scope')
  .option('-a, --agent <agent>', 'only memories written by this agent')
  .option('-f, --format <format>', 'jsonl | md', 'jsonl')
  .option('-o, --out <file>', 'output file, - for stdout', '-')
  .action((options) => {
    const { store, close } = openEngine();
    try {
      const records = exportRecords(store, { project: options.project, agent: options.agent });
      const text = options.format === 'md' ? renderMarkdown(records) + '\n' : writeJsonl(records);
      if (options.out === '-') {
        process.stdout.write(text);
      } else {
        fs.writeFileSync(options.out, text, 'utf-8');
        console.log(`exported ${records.length} memories -> ${options.out}`);
      }
    } finally {
      close();
    }
  });

// ── import ────────────────────────────────────────

program
  .command('import')
  .description('import memories from jsonl (idempotent, re-embeds)')
  .argument('<file>', 'jsonl file, - for stdin')
  .option('-a, --agent <agent>', 'override the agent attribution')
  .action(async (file: string, options) => {
    const { engine, close } = openEngine();
    try {
      const text = file === '-'
        ? fs.readFileSync(0, 'utf-8') // stdin
        : fs.readFileSync(file, 'utf-8');
      const counts = await importJsonl(engine, text, { agent: options.agent });
      console.log(
        `import done: ${counts.created} created, ` +
        `${counts.reinforced} reinforced (merged), ${counts.skipped} skipped`,
      );
    } finally {
      close();
    }
  });

// ── compile ───────────────────────────────────────────────────────────────

program
  .command('compile')
  .description('compile memories into agent-native markdown (AGENTS.md / CLAUDE.md / .cursor/rules) so agents auto-load them')
  .option('-t, --target <target>', `one of ${TARGETS.join(', ')}, or all`, 'agents-md')
  .option('-o, --out <path>', 'output file (agents-md/claude-md) or directory (cursor); defaults to the conventional path')
  .option('-p, --project <project>', 'only memories in this project scope')
  .option('-a, --agent <agent>', 'only memories written by this agent')
  .option('--min-strength <n>', 'only memories with strength >= n (default 1 = all)', '1')
  .option('--dry-run', 'print what would be written; do not touch the filesystem')
  .action((options) => {
    const targets: CompileTarget[] = options.target === 'all'
      ? TARGETS
      : (TARGETS.includes(options.target) ? [options.target as CompileTarget] : (() => { throw new Error(`unknown target: ${options.target}. one of ${TARGETS.join(', ')}, all`); })());
    const minStrength = Number(options.minStrength) || 1;
    const { store, close } = openEngine();
    try {
      const records = exportRecords(store, {
        project: options.project,
        agent: options.agent,
      }) as unknown as import('./memory.js').MemoryRecord[];
      for (const target of targets) {
        const r = compileTarget(target, records, {
          outPath: options.out,
          project: options.project,
          minStrength,
          dryRun: options.dryRun,
        });
        if (options.dryRun) {
          console.log(`[dry-run] ${target}: would write ${r.files.join(', ')} (${r.memoryCount} memories)`);
        } else {
          for (const f of r.files) console.log(`${target} -> ${f} (${r.memoryCount} memories)`);
        }
      }
    } finally {
      close();
    }
  });

// ── brief ─────────────────────────────────────────

program
  .command('brief')
  .description('project brief: integrate memories/tasks across sessions into a "where are we now" digest (time-aware, latest first)')
  .option('-p, --project <project>', 'project scope (omit = all projects)')
  .action(async (options) => {
    const { projectBrief } = await import('./brief.js');
    const { store, close } = openEngine();
    try {
      const records = exportRecords(store, {}) as unknown as import('./memory.js').MemoryRecord[];
      const out = projectBrief(records, { project: options.project ?? '' });
      console.log(out !== '' ? out : `no memories or tasks${options.project ? ` for project "${options.project}"` : ''} — run \`hippo distill\` first`);
    } finally {
      close();
    }
  });

// ── handoff（H7 M5a）：推准备、拉消费的寄存层 ──────

program
  .command('handoff')
  .description('cross-agent handoff inbox: push a session snapshot, list pending, load (consume) one')
  .argument('<action>', 'push | inbox | load')
  .option('-s, --session <sessionId>', 'session file path or id (push)')
  .option('-t, --to <agent>', 'target agent label (push, metadata only)', 'any')
  .argument('[itemId]', 'inbox item id (load)')
  .action(async (action: string, itemId: string | undefined, options: { session?: string; to?: string }) => {
    const { pushHandoff, listInbox, loadHandoff } = await import('./handoff-inbox.js');
    if (action === 'push') {
      if (options.session === undefined) { console.error('--session required for push'); process.exitCode = 1; return; }
      try {
        const item = pushHandoff(options.session, { to: options.to });
        console.log(`已推送 ${item.id} ← ${item.from.agent}「${item.from.title}」（候选 ${item.candidates.length} · 任务 ${item.activeTasks.length} · ${item.git.changed.length} 文件改动）`);
        console.log(`接手方取件：hippo handoff load ${item.id}`);
      } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
    } else if (action === 'inbox') {
      const items = listInbox();
      if (items.length === 0) { console.log('收件箱为空'); return; }
      for (const it of items) console.log(`${it.id}  ← ${it.from.agent}「${it.from.title}」 ${new Date(it.pushedAt * 1000).toLocaleString()} → ${it.to}`);
    } else if (action === 'load') {
      if (itemId === undefined) { console.error('load 需要 itemId（hippo handoff inbox 查看待取）'); process.exitCode = 1; return; }
      try { console.log(loadHandoff(itemId).text); }
      catch (e) { console.error((e as Error).message); process.exitCode = 1; }
    } else {
      console.error(`未知动作：${action}（push | inbox | load）`); process.exitCode = 1;
    }
  });

// ── review（H9②）：待审队列 LLM 预审（打建议，人终审）──

program
  .command('review')
  .description('LLM pre-review the shelved queue: annotate each candidate with accept/discard suggestion + reason (humans still decide)')
  .action(async () => {
    const { withEngine } = await import('./engine.js');
    const { reviewShelved } = await import('./shelved-review.js');
    // CLI 场景无 dsh llm 桥——按 settings 直连默认 provider（minimax/ollama 均可）
    const { readDefaultModel, providerDirectComplete } = await import('../dsh-llm.js');
    const route = readDefaultModel();
    const complete = (system: string, user: string) =>
      providerDirectComplete(system, user, { temperature: 0 });
    if (route !== null) console.log(`预审模型：${route.provider}/${route.model}（LLM 仅建议，人终审）`);
    const st = await withEngine(async () => reviewShelved(complete));
    if (st.failed) { console.error('LLM 不可用，预审中断（队列未动）'); process.exitCode = 1; return; }
    console.log(`预审完成：${st.reviewed} 条 → 建议收 ${st.accept} / 弃 ${st.discard}`);
    console.log('GUI 蒸馏页可按建议勾选确认，或 hippo shelved-apply 人工执行');
  });

// ── secrets（H9）：存量库敏感信息扫描/清除 ─────────

program
  .command('secrets')
  .description('scan the memory store for API keys / passwords / tokens (secret-guard); --purge deletes hits')
  .option('--purge', 'delete memories containing secrets (destructive!)', false)
  .action(async (options: { purge?: boolean }) => {
    const { withEngine } = await import('./engine.js');
    const { listRecords } = await import('./transfer.js');
    const { findSecrets } = await import('./secret-guard.js');
    let rows: Record<string, unknown>[] = [];
    await withEngine(async ({ engine }) => {
      rows = listRecords(engine.store as never, { includeSuperseded: true, limit: 0 }) as unknown as Record<string, unknown>[];
    });
    const hits: Array<{ id: string; kinds: string; text: string }> = [];
    for (const r of rows) {
      const found = findSecrets(String(r.text ?? ''));
      if (found.length > 0) hits.push({ id: String(r.id), kinds: found.map(h => h.kind).join(', '), text: String(r.text ?? '') });
    }
    if (hits.length === 0) { console.log('✅ 全库扫描完成：未发现疑似密钥/凭证'); return; }
    console.log(`⚠️ 发现 ${hits.length} 条记忆含疑似敏感信息：`);
    for (const h of hits) {
      console.log(`  [${h.id.slice(0, 8)}] (${h.kinds}) ${h.text.slice(0, 70).split(String.fromCharCode(10)).join(' ')}`);
    }
    if (options.purge) {
      let del = 0;
      await withEngine(async ({ engine }) => {
        for (const h of hits) { if (await engine.forget(h.id)) del++; }
      });
      console.log(`已删除 ${del}/${hits.length} 条（--purge）`);
    } else {
      console.log('确认后执行：hippo secrets --purge');
    }
  });

// ── memoryfield（H8）：透明可移植镜像层 ───────────

program
  .command('memoryfield')
  .description('export memories as a Memoryfields directory (one .md per memory, spec-compliant) or import one back')
  .argument('<action>', 'export | import')
  .option('-d, --dir <dir>', 'target directory (export) or source directory (import)')
  .option('-p, --project <project>', 'project scope (export filter / import target)', '')
  .action(async (action: string, options: { dir?: string; project?: string }) => {
    if (options.dir === undefined || options.dir === '') { console.error('--dir required'); process.exitCode = 1; return; }
    if (action === 'export') {
      const { withEngine, exportMemoryfield } = await import('./engine.js');
      const { listRecords } = await import('./transfer.js');
      const { importMemoryfield } = await import('./memoryfield.js');
      const dir = options.dir as string;
      let stats = { pages: 0, skipped: 0, superseded: 0, bytes: 0 };
      await withEngine(async ({ engine }) => {
        const records = listRecords(engine.store as never, { project: options.project || undefined, includeSuperseded: true, limit: 0 }) as unknown as import('./memory.js').MemoryRecord[];
        stats = exportMemoryfield(records, dir);
      });
      console.log(`已导出 ${stats.pages} 页 → ${options.dir}（${(stats.bytes / 1024).toFixed(0)} KB；跳过空 ${stats.skipped}，含被取代链 ${stats.superseded}）`);
      console.log('目录即记忆：可用任何编辑器/grep 直接读写，也可按 memoryfield 规范同步/分发。');
    } else if (action === 'import') {
      const { importMemoryfield } = await import('./memoryfield.js');
      const dir = options.dir as string;
      const pages = importMemoryfield(dir, options.project ? { project: options.project } : {});
      if (pages.length === 0) { console.log('目录无有效页面'); return; }
      const { withEngine } = await import('./engine.js');
      const { importJsonl } = await import('./transfer.js');
      let counts = { created: 0, reinforced: 0, skipped: 0 };
      await withEngine(async ({ engine }) => {
        const jsonlText = pages.map((p: { text: string }) => JSON.stringify({ text: p.text, type: 'fact', project: options.project || 'memoryfield-import', agent: 'memoryfield' })).join('\n');
        counts = await importJsonl(engine, jsonlText);
      });
      console.log(`导入 ${pages.length} 页：created=${counts.created} reinforced=${counts.reinforced} skipped=${counts.skipped}`);
    } else {
      console.error(`未知动作：${action}（export | import）`); process.exitCode = 1;
    }
  });

// ── distill ───────────────────────────────────────

program
  .command('distill')
  .description('extract memories from a session transcript')
  .option('-f, --file <path>', 'transcript jsonl path; - for stdin (omit to auto-find latest)')
  .option('-p, --project <project>', 'override project scope (else from cwd)')
  .option('-a, --agent <agent>', 'attribution tag', 'distill:claude')
  .option('--apply', 'write candidates to the store (default: dry-run preview)')
  .option('-n, --limit <number>', 'max candidates to keep/apply', '20')
  .action(async (options) => {
    const { entryToTurns, parseJsonl } = await import('../patterns/transcript.js');
    const { extractCandidates, distill: runDistill, candidateToDict } = await import('./distill.js');

    // -f omitted: auto-find the latest Claude transcript under ~/.claude/projects/
    let filePath = options.file;
    if (!filePath) {
      const { findTranscripts } = await import('../patterns/miner.js');
      const latest = findTranscripts(undefined, 1)[0];
      if (!latest) {
        console.log('no transcript found under ~/.claude/projects/. pass --file PATH explicitly.');
        return;
      }
      console.log(`(auto: ${latest})`);
      filePath = latest;
    }

    const source = filePath === '-' ? 'stdin' : filePath;
    const text = filePath === '-'
      ? fs.readFileSync(0, 'utf-8')
      : fs.readFileSync(filePath, 'utf-8');

    const turns = [];
    for (const entry of parseJsonl(text)) turns.push(...entryToTurns(entry));
    if (!turns.length) {
      console.log(`(no conversation turns parsed from ${source})`);
      return;
    }

    const candidates = extractCandidates(turns, { projectOverride: options.project })
      .slice(0, Number(options.limit));
    if (!candidates.length) {
      console.log('(no memorable signals found in this transcript)');
      return;
    }

    // Always score against the store (shows new/reinforce/maybe bands).
    const { engine, close } = openEngine();
    try {
      const result = await runDistill(engine, candidates, {
        apply: Boolean(options.apply), agent: options.agent, turns,
      });

      const mode = options.apply ? 'APPLY' : 'DRY-RUN';
      console.log(`\n${mode}: ${candidates.length} candidates from ${source}`);
      for (const c of candidates) {
        const marks: Record<string, string> = { new: '+', reinforce: '=', maybe: '?' };
        const mark = marks[c.duplicate] ?? ' ';
        console.log(`  ${mark} [${c.type}|${c.confidence.toFixed(2)}|${c.project}] ${c.text.slice(0, 70)}`);
      }
      console.log('');
      if (options.apply) {
        console.log(
          `created=${result.created} reinforced=${result.reinforced} ` +
          `maybe(skipped)=${result.maybe} skipped=${result.skipped}`,
        );
      } else {
        console.log('dry-run: nothing written. Re-run with --apply to commit.');
        if (result.maybe || candidates.some(c => c.duplicate === 'maybe')) {
          console.log('(? = likely duplicate, not auto-merged — review before applying)');
        }
      }
      void candidateToDict; // exported for MCP server reuse
    } finally {
      close();
    }
  });

// ── patterns ──────────────────────────────────────

program
  .command('patterns')
  .description('mine recurring tool workflows across sessions')
  .option('-d, --dir <path>', 'transcripts dir (default: ~/.claude/projects)')
  .option('-n, --limit <number>', 'only scan the N newest transcripts (default: all)', '0')
  .option('--min-sessions <number>', 'pattern must appear in this many distinct sessions', '2')
  .option('--min-count <number>', 'pattern must occur at least this many times in total', '3')
  .option('--top <number>', 'show at most this many patterns', '20')
  .option('--json', 'machine-readable output')
  .option('--export <dir>', 'export top patterns as <dir>/<name>/SKILL.md drafts')
  .option('--export-top <number>', 'how many patterns to export', '5')
  .action(async (options) => {
    const {
      findTranscripts, loadSessionEvents, minePatterns,
      patternToDict, renderPattern, scorePatterns,
    } = await import('../patterns/miner.js');

    const files = findTranscripts(options.dir, Number(options.limit));
    if (!files.length) {
      console.log('no transcripts found. Pass --dir PATH or check ~/.claude/projects/.');
      return;
    }
    const sessions = new Map<string, import('../patterns/miner.js').ToolEvent[]>();
    for (const f of files) {
      const events = loadSessionEvents(f);
      if (events.length) sessions.set(path.basename(f, '.jsonl'), events);
    }
    if (!sessions.size) {
      console.log(`(no tool calls found in ${files.length} transcripts)`);
      return;
    }

    const patterns = minePatterns(sessions, {
      minSessions: Number(options.minSessions), minCount: Number(options.minCount),
    });
    const ranked = scorePatterns(patterns).slice(0, Number(options.top));
    console.log(
      `scanned ${sessions.size} sessions with tool calls ` +
      `(${files.length} transcripts), ${patterns.length} patterns survived filtering\n`,
    );
    if (!ranked.length) {
      console.log('(no recurring cross-session workflows — try lowering --min-sessions/--min-count)');
      return;
    }
    if (options.json) {
      console.log(JSON.stringify(ranked.map(patternToDict), null, 2));
    } else {
      for (const p of ranked) console.log(renderPattern(p) + '\n');
    }
    if (options.export) {
      const { exportSkills } = await import('./sop.js');
      const paths = exportSkills(ranked, options.export, { top: Number(options.exportTop) });
      console.log(`exported ${paths.length} skill drafts (review before use):`);
      for (const p of paths) console.log(`  ${p}`);
    }
  });

// ── serve (MCP stdio) ─────────────────────────────

program
  .command('serve')
  .description('run the MCP stdio server')
  .option('--http <url>', 'proxy to a running hippo HTTP server (e.g. http://localhost:8140) instead of opening a local engine — avoids the zvec single-writer lock so the Web UI can run concurrently')
  .option('--telegram <token>', 'start a Telegram Bot (long-polling; requires ollama for LLM replies)')
  .option('--ollama <url>', 'ollama endpoint for Telegram LLM replies (default http://127.0.0.1:11434)')
  .action(async (options) => {
    if (options.telegram) {
      const { startTelegramBot } = await import('./telegram.js');
      startTelegramBot({
        token: String(options.telegram),
        ollamaUrl: options.ollama ? String(options.ollama) : undefined,
      });
    }
    const { serve } = await import('./server.js');
    await serve({ httpUrl: options.http });
  });

// ── doctor ────────────────────────────────────────

program
  .command('doctor')
  .description('diagnose and recover a broken memory store')
  .option('--salvage <out.jsonl>', 'read all memories and write to JSONL (no engine open)')
  .option('--rebuild', 'salvage → backup → drop db → re-import (re-embeds everything)')
  .option('--backup <path>', 'rebuild backup path (default: temp file)', '')
  .action(async (options) => {
    const doc = await import('./doctor.js');

    if (options.rebuild) {
      const r = await doc.rebuild(options.backup || undefined);
      console.log(`salvaged ${r.salvaged} → backup: ${r.backup}`);
      console.log(`rebuild: ${r.created} created, ${r.reinforced} reinforced, ${r.skipped} skipped`);
      return;
    }
    if (options.salvage) {
      const records = await doc.salvage();
      doc.writeJsonl(records, options.salvage);
      console.log(`wrote ${records.length} records to ${options.salvage}`);
      return;
    }

    // Default: diagnose (read-only).
    const d = await doc.diagnose();
    console.log(`data dir:    ${d.dataDir}`);
    console.log(`db:          ${d.dbExists ? d.dbPath : '(missing)'}`);
    if (!d.dbExists) {
      console.log('\nno store yet — nothing to diagnose.');
      console.log('  hippo remember "first memory"  # to create one');
      return;
    }
    console.log(`integrity:   ${d.integrity}`);
    if (d.integrity !== 'ok') {
      console.log('\n⚠ integrity check failed — run `hippo doctor --rebuild` to recover.');
      console.log('  hippo doctor --salvage out.jsonl   # back up data first');
      return;
    }
    console.log(`memories:    ${d.memoryCount}`);
    console.log(`vectors:     ${d.vectorCount}${d.vectorDim ? ` (${d.vectorDim}-d)` : ''}`);
    if (d.providerDim && d.vectorDim && d.dimMismatch) {
      console.log(`⚠ dimension mismatch: store is ${d.vectorDim}-d but provider is ${d.providerDim}-d`);
      console.log('  run `hippo doctor --rebuild` to re-embed with the current model.');
    }
    if (d.orphanVectors > 0) console.log(`orphan vectors: ${d.orphanVectors} (vec_memories rows pointing at deleted memories)`);
    if (d.orphanMemories > 0) console.log(`orphan memories: ${d.orphanMemories} (memories missing a vector — recall will skip them)`);
    if (Math.abs(d.ftsDrift) > 0) console.log(`fts drift: ${d.ftsDrift > 0 ? '+' : ''}${d.ftsDrift} (memories minus memories_fts rows)`);

    const healthy = !d.dimMismatch && d.orphanVectors === 0 && d.orphanMemories === 0 && d.ftsDrift === 0;
    if (healthy) {
      console.log('\n✓ store looks healthy.');
    } else {
      console.log('\nissues found — most can be fixed with `hippo doctor --rebuild`.');
    }
  });

// ── gui（G1：生产形态一键启动）──────────────────────

program
  .command('gui')
  .description('start the HTTP API, serve the built web UI, and open it in the browser')
  .option('-p, --port <port>', 'HTTP port (default: a random free port on 127.0.0.1)', '0')
  .option('--web-dir <path>', 'web build output dir (default: <repo>/web/dist)', '')
  .option('--no-open', "don't open the browser")
  .action(async (options) => {
    const { existsSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    // web/dist 探测：tsx 源码态(src/hippo/cli.ts)与编译态(dist/hippo/cli.js)各回退一层
    const here = fileURLToPath(import.meta.url);
    const candidates = options.webDir
      ? [options.webDir]
      : [join(dirname(dirname(dirname(here))), 'web', 'dist'), join(dirname(dirname(here)), 'web', 'dist')];
    const staticDir = candidates.find((d) => existsSync(join(d, 'index.html')));

    const { startHttpServer } = await import('./server-http.js');
    const server = startHttpServer(Number(options.port) || 0, staticDir ? { staticDir } : {});
    console.log(`hippo gui → ${server.url}`);
    if (staticDir) {
      console.log(`  UI: ${staticDir}`);
    } else {
      console.log('  (未找到 web/dist 构建产物——API 正常可用；要出页面先 `cd web && pnpm build`，或开发模式用 vite dev + `hippo ui`)');
    }
    console.log('  首次启动会在后台建会话索引（全量约半分钟，之后增量毫秒级）；Ctrl+C 停止');
    if (options.open) {
      try {
        const open = (await import('open')).default;
        await open(server.url);
      } catch {
        // 'open' optional — user opens manually
      }
    }
    const shutdown = () => { server.close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// ── ui ───────────────────────────────────────────

program
  .command('ui')
  .description('start the local HTTP API + open the web UI in the browser (dev mode: Vite at 5173)')
  .option('-p, --port <port>', 'HTTP port', '8139')
  .option('--no-open', "don't open the browser")
  .action(async (options) => {
    const { startHttpServer } = await import('./server-http.js');
    const port = Number(options.port);
    const server = startHttpServer(port);
    console.log(`hippo API on ${server.url}`);
    console.log('  web UI → http://localhost:5173 (dev) or build web/ and serve from here');
    console.log('  press Ctrl+C to stop');
    if (options.open) {
      try {
        const open = (await import('open')).default;
        // prefer the vite dev server if running; else fall back to API root
        await open('http://localhost:5173').catch(() => open(server.url));
      } catch {
        // 'open' optional — user opens manually
      }
    }
    // keep alive until killed
    const shutdown = () => { server.close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// ── web ──────────────────────────────────────────

program
  .command('web')
  .description('generate a single-file HTML dashboard of all memories')
  .option('-o, --out <path>', 'output file (default: hippo-dashboard.html in cwd)', '')
  .option('--no-open', "don't open the file in the browser after writing")
  .action(async (options) => {
    const { buildPayload, renderHtml } = await import('./dashboard.js');
    const payload = buildPayload();
    const html = renderHtml(payload);
    const outPath = options.out || path.join(process.cwd(), 'hippo-dashboard.html');
    fs.writeFileSync(outPath, html, 'utf-8');
    console.log(`wrote ${payload.total} memories to ${outPath}`);
    if (payload.total === 0) {
      console.log('(store is empty — the dashboard will show a placeholder. try `hippo remember "hello" -t fact`)');
    }
    if (options.open) {
      try {
        const open = (await import('open')).default;
        await open(outPath);
      } catch {
        // 'open' optional — user can open the file manually
      }
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
