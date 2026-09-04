/**
 * MCP stdio server exposing semantic memory tools to any MCP client.
 * TS port of hippo server.py, minus the leader/follower election — that
 * existed because zvec grants its collection lock to exactly one process.
 * SQLite WAL allows many processes on one store, so every server instance
 * just opens its own engine.
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openEngine } from './engine.js';
import { VALID_TYPES, type MemoryEngine } from './memory.js';
import { candidateToDict, distill as runDistill, extractCandidates } from './distill.js';
import { entryToTurns, parseJsonl } from '../patterns/transcript.js';
import { HttpProxyEngine } from './http-proxy-engine.js';
// MCP 一等公民（P0-2）：演化链 + 自动蒸馏状态/待复核 + 库概览
import { loadAutoSettings, listShelved, takeShelved } from './auto-distill.js';
import { buildPayload } from './dashboard.js';

/** A minimal engine interface covering the methods the MCP tools call.
 * HttpProxyEngine satisfies this without holding a zvec lock. */
type McpEngine = Pick<MemoryEngine, 'remember' | 'recall' | 'update' | 'forget'>
  & Partial<Pick<MemoryEngine, 'markSuperseded' | 'store'>>;

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Wrap a handler, converting thrown errors to structured results. */
function safe<T extends unknown[]>(fn: (...args: T) => Promise<unknown>) {
  return async (...args: T) => {
    try {
      return jsonResult(await fn(...args));
    } catch (err) {
      return jsonResult({
        status: 'error',
        error: (err as Error).message,
        error_type: (err as Error).constructor.name,
      });
    }
  };
}

const MEMORY_TYPE = z.enum(VALID_TYPES);

/** Build the MCP server around an engine (injectable for tests).
 *
 * In HTTP-proxy mode (`distillUnavailable`), the distill tool is omitted
 * because candidate extraction needs the local embedder + store search,
 * which the HTTP API doesn't expose. remember/recall/update/forget are
 * fully proxied and cover the agent's everyday memory operations. */
export function createHippoMcpServer(engine: McpEngine, opts: { distillUnavailable?: boolean } = {}): McpServer {
  const req = createRequire(import.meta.url);
  const pkgVersion = (req('../../package.json') as { version?: string }).version ?? '0.3.0';
  const server = new McpServer({ name: 'hippo', version: pkgVersion });

  server.registerTool('remember', {
    description:
      'Save a memory for future sessions and other agents. Use for durable ' +
      'facts, decisions, lessons learned, or user preferences — not for ' +
      'transient conversation details. `project` scopes the memory (use the ' +
      'repo/project name, or "global" for cross-project knowledge). ' +
      'Near-duplicate memories are merged automatically.',
    inputSchema: {
      text: z.string().describe('memory text'),
      type: MEMORY_TYPE.default('fact'),
      project: z.string().default('global'),
      agent: z.string().default('unknown'),
    },
  }, safe(async ({ text, type, project, agent }: { text: string; type: string; project: string; agent: string }) => {
    const r = await engine.remember(text, { type, project, agent });
    if (r.status === 'rejected') {
      return `❌ 已拒绝入库：疑似敏感信息（${r.reason}）。密钥不应进入记忆库。`;
    }
    return r.status === 'reinforced'
      ? `已强化既有记忆（${r.id}，strength ${r.strength}）`
      : `已记住（${r.id}）`;
  }));

  server.registerTool('recall', {
    description:
      'Retrieve memories relevant to a query. Searches the given project ' +
      'scope plus global scope, ranked by semantic similarity, recency, and ' +
      'reinforcement strength. Call this at the start of a task to load ' +
      'prior context.',
    inputSchema: {
      query: z.string(),
      project: z.string().default('global'),
      limit: z.number().int().positive().default(5),
    },
  }, safe(async ({ query, project, limit }: { query: string; project: string; limit: number }) => {
    const hits = await engine.recall(query, { project, limit });
    // H11 M-B：旧环境事实引用前先验证（stale 由引擎标注）
    const lines = hits.map((h) => {
      if (!h.stale) return `- [${h.type}] ${h.text} (id: ${h.id})`;
      return `- [${h.type}] ⚠ 距今 ${h.ageDays} 天，引用前先验证：${h.text} (id: ${h.id})`;
    });
    return lines.length > 0 ? lines.join('\n') : '未找到相关记忆。';
  }));

  server.registerTool('update', {
    description:
      'Edit an existing memory in place, preserving its strength. Use this ' +
      'to correct a memory rather than delete-and-remember (which would ' +
      'reset reinforcement strength). Provide only the fields you want to ' +
      'change. If `text` is changed, its embedding is recomputed ' +
      'automatically so recall still finds it.',
    inputSchema: {
      memory_id: z.string(),
      text: z.string().optional(),
      type: MEMORY_TYPE.optional(),
      project: z.string().optional(),
    },
  }, safe(async ({ memory_id, text, type, project }: { memory_id: string; text?: string; type?: string; project?: string }) =>
    engine.update(memory_id, { text, type, project })));

  server.registerTool('forget', {
    description: 'Delete a memory by id (as returned by remember/recall).',
    inputSchema: { memory_id: z.string() },
  }, safe(async ({ memory_id }: { memory_id: string }) => ({ deleted: await engine.forget(memory_id) })));


  server.registerTool('stats', {
    description:
      'Memory library overview: total memories, per-project and per-type ' +
      'counts, and how many are superseded (old versions kept for audit).',
    inputSchema: {},
  }, safe(async () => {
    const payload = engine.store ? buildPayload(engine.store as never) : null;
    return payload ?? { status: 'error', error: 'stats requires a local engine' };
  }));

  server.registerTool('supersede', {
    description:
      'Mark an old memory as superseded by a newer one (lightweight ' +
      'bi-temporal chain). The old memory is kept for audit but excluded ' +
      'from compiled files and downweighted in recall. Use when a decision ' +
      'was reversed: supersede(old_decision, new_decision).',
    inputSchema: {
      old_id: z.string().describe('memory id of the outdated version'),
      new_id: z.string().describe('memory id of the current version'),
    },
  }, safe(async ({ old_id, new_id }: { old_id: string; new_id: string }) => {
    if (!engine.markSuperseded) return { status: 'error', error: 'supersede requires a local engine' };
    return { ok: await engine.markSuperseded(old_id, new_id) };
  }));

  server.registerTool('memory_status', {
    description:
      'Auto-distill status: mode (off/review/auto), threshold, interval, ' +
      'last run stats, and how many candidates are waiting for review.',
    inputSchema: {},
  }, safe(async () => {
    const st = loadAutoSettings();
    return { settings: st, shelvedWaiting: listShelved().length };
  }));

  server.registerTool('memory_review', {
    description:
      'Review shelved distill candidates (the maybe band and low-confidence ' +
      'ones auto-distill parked instead of writing). ' +
      'action=list returns them; action=apply writes the selected indices ' +
      'into the memory store; action=discard drops them.',
    inputSchema: {
      action: z.enum(['list', 'apply', 'discard']),
      indices: z.array(z.number().int()).optional().describe('indices to apply/discard (from list)'),
    },
  }, safe(async ({ action, indices }: { action: 'list' | 'apply' | 'discard'; indices?: number[] }) => {
    if (action === 'list') {
      return { items: listShelved().map((x, i) => ({ index: i, reason: x.reason, project: x.candidate.project, type: x.candidate.type, confidence: x.candidate.confidence, text: x.candidate.text })) };
    }
    if (!indices || indices.length === 0) return { status: 'error', error: 'indices required for apply/discard' };
    if (action === 'discard') return { remaining: takeShelved(indices) };
    const all = listShelved();
    const cands = indices.filter(i => all[i]).map(i => ({ ...all[i].candidate }));
    if (cands.length === 0) return { status: 'error', error: 'no such items' };
    const full = engine as unknown as MemoryEngine;
    const r = await runDistill(full, cands, { apply: true, agent: 'mcp:review' });
    takeShelved(indices);
    return { created: r.created, reinforced: r.reinforced, skipped: r.skipped };
  }));

  // distill needs the local embedder + store.search (not exposed over HTTP),
  // so it's only registered when running against a real in-process engine.
  if (!opts.distillUnavailable) {
  server.registerTool('compile', {
    description:
      'Compile memories into an AGENTS.md / CLAUDE.md file for a project. ' +
      'The file is what agents read at startup to preload your experience. ' +
      'Defaults to index mode: a compact one-line-per-memory index (saves tokens). ' +
      'Pass indexMode=false only when a full-text projection is explicitly needed.',
    inputSchema: {
      target: z.enum(['agents-md', 'claude-md', 'cursor', 'all']).default('agents-md'),
      project: z.string().optional(),
      indexMode: z.boolean().default(true),
      outPath: z.string().optional(),
    },
  }, safe(async ({ target, project, indexMode, outPath }: { target: string; project?: string; indexMode: boolean; outPath?: string }) => {
    const { compileTarget } = await import('./compile.js');
    const records = [];
    const store = engine.store ?? null;
    if (store === null) return { status: 'error', error: 'compile requires a local engine' };
    const { exportRecords } = await import('./transfer.js');
    const recs = exportRecords(store as never, { project }) as unknown as Array<Record<string, unknown> & { superseded_by?: string }>;
    const active = recs.filter(r => !r.superseded_by);
    const result = compileTarget(target as never, active as never, { outPath, indexMode: indexMode !== false });
    return result;
  }));

  server.registerTool('sleep', {
    description:
      'Memory maintenance: merge near-duplicates (sim≥0.95), recycle orphan ' +
      'L0 sources (moved to trash, recoverable), and drop stale shelved ' +
      'candidates (>30 days). Run with apply=false for a dry-run report.',
    inputSchema: {
      apply: z.boolean().default(false),
    },
  }, safe(async ({ apply }: { apply: boolean }) => {
    if (!engine.store) return { status: 'error', error: 'sleep requires a local engine' };
    const { runSleep } = await import('./sleep.js');
    return runSleep(engine as never, { apply });
  }));

  server.registerTool('session_delete', {
    description:
      'Remove a session from hippo (index + list). Source file preserved ' +
      'unless deleteSource=true. Deleted sessions are added to .hippoignore ' +
      'to prevent re-import. Memories already distilled are kept.',
    inputSchema: {
      session_id: z.string(),
      deleteSource: z.boolean().default(false),
    },
  }, safe(async ({ session_id, deleteSource }: { session_id: string; deleteSource: boolean }) => {
    const { deleteSession } = await import('../agents/session-delete.js');
    return deleteSession(session_id, { deleteSource });
  }));

  server.registerTool('task_list', {
    description:
      'List current tasks for a project (extracted from TodoWrite calls in sessions). ' +
      'Shows active (pending/in_progress) and completed tasks with priorities.',
    inputSchema: {
      project: z.string().describe('project scope to filter tasks by'),
    },
  }, safe(async ({ project }: { project: string }) => {
    const { tasksForProject } = await import('./task-context.js');
    const tasks = tasksForProject(project);
    if (tasks.length === 0) return { tasks: [], note: 'No tasks found for this project' };
    return { tasks: tasks.map(t => ({ text: t.text, status: t.status, priority: t.priority, updatedAt: t.updatedAt })) };
  }));

  // ── H7 M5b：handoff 收件箱（推准备、拉消费；消费即弃）──
  // ── H12 M-03/M-01：context_fold（会话内压缩即服务）+ memory_archive（tier 老化）──
  server.registerTool('context_fold', {
    description:
      'Fold a consumed conversation segment into structured memories. Pass the raw text ' +
      'of a discussion you are about to discard from working context; hippo distills it into ' +
      'durable memories (with your refiner pipeline) and returns the folded points. ' +
      'After folding you can safely drop the original text — recall can retrieve details later.',
    inputSchema: {
      text: z.string().describe('consumed conversation/discussion segment to fold'),
      project: z.string().default('global'),
    },
  }, safe(async ({ text, project }: { text: string; project: string }) => {
    const { foldText } = await import('./fold.js');
    const { getDistillRefiner } = await import('./auto-distill-run.js');
    const r = await foldText(engine as never, text, { project, refiner: getDistillRefiner() ?? undefined });
    const list = r.folded.map((f, i) => `${i + 1}. ${f}`).join('\n');
    return `${r.note}\n${list}`;
  }));

  server.registerTool('memory_archive', {
    description:
      'Tier-aging archive: roll up memories older than 90 days (per project+month, groups of 3+) ' +
      'into digest memories; originals sink via supersede chain (reversible). ' +
      'Pass apply=true to execute; default is a dry-run report.',
    inputSchema: {
      apply: z.boolean().default(false),
    },
  }, safe(async ({ apply }: { apply: boolean }) => {
    const { tierAge } = await import('./tier-aging.js');
    const { getRefinerBridge } = await import('./auto-distill-run.js');
    const report = await tierAge(engine as never, getRefinerBridge(), { apply, olderThanDays: 90 });
    const head = apply
      ? `归档完成：${report.groupsFound} 组 → 创建摘要 ${report.digestsCreated}，沉底 ${report.archived} 条${report.llmUsed ? '（LLM 压缩）' : '（规则拼接降级）'}`
      : `dry-run：发现 ${report.groupsFound} 组可归档（apply=true 执行）`;
    const rows = report.groups.map(g => `  · ${g.project} ${g.month} [${g.type}] ${g.ids.length} 条`).join('\n');
    return `${head}\n${rows}`;
  }));

  server.registerTool('handoff_inbox', {
    description:
      'List pending handoff snapshots pushed from other agent sessions (cross-agent context handoff). ' +
      'Check this at conversation start; each item is a distilled task/git/candidate snapshot with an id for handoff_load.',
    inputSchema: {},
  }, safe(async () => {
    const { listInbox } = await import('./handoff-inbox.js');
    const items = listInbox();
    if (items.length === 0) return '收件箱为空（无待取交接快照）';
    return items.map(it => `${it.id} ← ${it.from.agent}「${it.from.title}」 ${new Date(it.pushedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')}（候选${it.candidates.length}·任务${it.activeTasks.length}）`).join('\n') + '\n取件：handoff_load(item_id)';
  }));

  server.registerTool('handoff_load', {
    description:
      'Load (consume) one pending handoff snapshot by id. Returns a <=500-token detail (tasks/blocker/distilled candidates ' +
      'plus a session pointer for on-demand原文反查). Consume-once: the item is archived after loading — 快照是历史事实，执行前须当下确认。',
    inputSchema: {
      item_id: z.string().describe('id from handoff_inbox'),
    },
  }, safe(async ({ item_id }: { item_id: string }) => {
    const { loadHandoff } = await import('./handoff-inbox.js');
    return loadHandoff(item_id).text;
  }));

  server.registerTool('task_update', {
    description:
      'Update a task status (mark complete, start working on it, etc). ' +
      'The agent should call this after finishing work on a task.',
    inputSchema: {
      project: z.string().describe('project scope'),
      task_text: z.string().describe('partial task text to match'),
      status: z.enum(['pending', 'in_progress', 'completed']),
    },
  }, safe(async ({ project, task_text, status }: { project: string; task_text: string; status: string }) => {
    const { updateTaskStatus, loadTasks } = await import('./task-context.js');
    const ok = updateTaskStatus(project, task_text, status as 'pending' | 'in_progress' | 'completed');
    // M3 完成回流：置 completed 时组装 Candidate 走既有蒸馏管线（独立 L0 事件源）。
    // 失败不影响状态更新本身；HTTP 代理模式（无本地 embedder/store）自动跳过。
    if (ok && status === 'completed' && !opts.distillUnavailable) {
      try {
        const task = loadTasks().find(t => t.project === project
          && t.status === 'completed' && t.text.includes(task_text.slice(0, 20)));
        const full = engine as MemoryEngine;
        if (task && engine.store) { // embedder 是方法引用恒真（TS2774）；proxy 由 distillUnavailable 挡
          const { taskRefluxCandidates } = await import('./task-reflux.js');
          await runDistill(full, taskRefluxCandidates([task]), { apply: true, agent: 'distill:task' });
        }
      } catch { /* 回流失败不阻塞 task_update */ }
    }
    return { ok, message: ok ? `Task "${task_text}" -> ${status}` : `Task not found: "${task_text}" in ${project}` };
  }));

  server.registerTool('distill', {
    description:
      'Extract memorable candidates from a session transcript (dry-run). ' +
      'Pass the raw transcript text (Claude Code JSONL, one JSON object per ' +
      'line, or plain conversation text). Returns a list of candidate ' +
      'memories, each tagged with type/confidence/project and a duplicate ' +
      'band (new/reinforce/maybe). This does NOT write anything — review ' +
      'the candidates and call `remember` for the ones worth keeping. ' +
      "'maybe' candidates are likely duplicates of existing memories and " +
      'should not be re-added.',
    inputSchema: {
      transcript: z.string(),
      project: z.string().optional(),
      agent: z.string().default('distill:claude'),
    },
  }, safe(async ({ transcript, project, agent }: { transcript: string; project?: string; agent: string }) => {
    const turns = [];
    for (const entry of parseJsonl(transcript)) turns.push(...entryToTurns(entry));
    const candidates = extractCandidates(turns, { projectOverride: project });
    const result = await runDistill(engine as MemoryEngine, candidates, { apply: false, agent, turns });
    return result.candidates.map(candidateToDict);
  }));
  }

  return server;
}

/** Run the stdio server (entry point for `hippo serve`).
 *
 * Two modes:
 *  - local (default): open an in-process engine. Holds the zvec write lock,
 *    so the Web UI (`hippo ui`) cannot run at the same time.
 *  - http (--http <url>): proxy all engine calls to a running `hippo ui`
 *    HTTP server. Holds NO lock, so the Web UI and any number of MCP clients
 *    work concurrently. distill is unavailable in this mode (candidate
 *    extraction needs the local embedder); use the CLI for distill.
 */
export async function serve(opts: { httpUrl?: string } = {}): Promise<void> {
  const transport = new StdioServerTransport();
  let close = () => {};

  if (opts.httpUrl) {
    // Proxy mode — no local store, no lock. Verifies the HTTP server is up
    // so we fail fast with a clear message instead of a per-call 404.
    try {
      const probe = await fetch(`${opts.httpUrl}/api/stats`);
      if (!probe.ok) throw new Error(`stats -> ${probe.status}`);
    } catch (err) {
      throw new Error(
        `cannot reach hippo HTTP server at ${opts.httpUrl} (${(err as Error).message}). ` +
        `Start it with \`hippo ui\` first, or run \`hippo serve\` without --http for a local engine.`,
      );
    }
    const engine = new HttpProxyEngine(opts.httpUrl.replace(/\/$/, ''));
    const server = createHippoMcpServer(engine, { distillUnavailable: true });
    await server.connect(transport);
  } else {
    const opened = openEngine();
    close = opened.close;
    const server = createHippoMcpServer(opened.engine);
    await server.connect(transport);
  }

  const shutdown = () => {
    close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
