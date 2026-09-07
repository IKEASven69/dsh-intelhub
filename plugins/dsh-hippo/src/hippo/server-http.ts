/**
 * HTTP API server for the React web UI.
 *
 * Wraps a single long-lived MemoryEngine in Express endpoints. One process,
 * one SQLite handle — the UI calls these endpoints instead of opening the
 * store per request (avoids write-lock contention).
 *
 * Routes:
 *   GET    /api/stats                        counts by project/type
 *   GET    /api/memories                     list (project?, type?, agent?, limit?, offset?)
 *   GET    /api/memories/:id                 single memory (full record)
 *   POST   /api/memories                     { text, type?, project?, agent? } -> RememberResult
 *   PATCH  /api/memories/:id                 { text?, type?, project? }
 *   DELETE /api/memories/:id
 *   POST   /api/recall                       { query, project?, limit? } -> RecallHit[]
 *   POST   /api/distill/preview              { transcript, project?, agent? } -> Candidate[]
 *   POST   /api/distill/apply                { candidates, agent? } -> DistillResult
 *   GET    /api/patterns                     { dir?, limit?, minSessions?, minCount?, top? }
 *   POST   /api/patterns/export              { dir, top? } -> { exported: string[] }
 *   POST   /api/compile/preview              { target, project?, minStrength? } -> { memoryCount, preview }
 *   POST   /api/compile                      { target, project?, minStrength?, outPath? } -> { files, memoryCount }
 *   GET    /api/sources                      list L0 source blobs
 *   GET    /api/sources/:id                  read one L0 blob
 *   GET    /api/doctor                       diagnostics (read-only)
 *   POST   /api/doctor/rebuild               salvage -> drop -> re-import
 *
 * No auth (localhost only). CORS opened for the Vite dev server (5173).
 */
import express from 'express';
import cors from 'cors';
import type { Server } from 'node:http';
import { withEngine, type HeldEngine } from './engine-holder.js';
import { VALID_TYPES, type MemoryType } from './memory.js';
import { listRecords, countRecords, exportRecords } from './transfer.js';
import { compileTarget, groupMemories, renderAgentsMd, renderIndexMd, renderCursorRules, defaultOutPath, TARGETS, type CompileTarget } from './compile.js';
import type { MemoryRecord, RecallHit } from './memory.js';
import { diagnose } from './doctor.js';
import { loadLlmSettings, saveLlmSettings, maskKey, completeWithSettings, PRESETS } from './llm-config.js';
import { setDistillRefiner } from './auto-distill-run.js';
import { llmRefine } from './refine.js';
import { buildPayload } from './dashboard.js';
import { listSources, loadSource, sourceTimes } from './sources.js';
import { extractCandidates, distill as runDistill, MAX_CANDIDATES, type Candidate } from './distill.js';
import { parseJsonl, entryToTurns, cwdToProject, type Turn } from '../patterns/transcript.js';
import { findTranscripts, loadSessionEvents, minePatterns, scorePatterns, patternToDict, type Pattern, type ToolEvent } from '../patterns/miner.js';
import { exportSkills } from './sop.js';
import { dataDir } from './store.js';
// 会话端点（G1）：适配器 + 索引层 + 导出格式；G2 增列表蒸馏标记与记忆反查
import {
  syncSessionIndex, getIndexedSession, searchSessions,
  indexStats, turnCountMap, recordSessionDistill, listSessionDistills,
  distilledCountMap, findSessionBySource,
} from '../agents/session-index.js';
import type { IndexedSession } from '../agents/session-index.js';
import { discoverAll, parseSession, loadIgnoreRules } from '../agents/index.js';
import { renderSessionMarkdown, renderSessionJson, safeFileStem } from '../agents/export.js';
import { resumePlanFor, launchTerminal } from '../agents/resume.js';
import { deleteSession } from '../agents/session-delete.js';
import { readTeamEvents } from '../team/adapter.js';
import { distillTeamEvents } from '../team/distill.js';
import { foldLedger } from '../team/ledger.js';
import { triage, resolvePromotion, resolveRetirement } from '../team/triage.js';
import { renderTeamMemoryMarkdown } from '../team/export-md.js';
import { runCycle } from '../team/cycle.js';
// 自动蒸馏（AD）：搁置队列 + 设置 + 定时扫描
import {
  loadAutoSettings, saveAutoSettings, listShelved, takeShelved,
  type AutoDistillSettings,
} from './auto-distill.js';
import { runAutoDistillOnce, startAutoDistillTimer, autoRecompile } from './auto-distill-run.js';
import { runSleep } from './sleep.js';
import {
  createResident, listResidents, getResident, deleteResident,
  createChannel, listChannels, getChannel, deleteChannel,
  appendMessage, readMessages, readBookmark, writeBookmark,
} from '../life/store.js';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_PORT = 8139;
const CORS_ORIGINS = ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173'];

/** Scan transcripts and build a sessionId -> events map for minePatterns. */
function loadSessions(baseDir?: string, limit = 0): Map<string, ToolEvent[]> {
  const files = findTranscripts(baseDir, limit);
  const sessions = new Map<string, ToolEvent[]>();
  for (const f of files) {
    const events = loadSessionEvents(f);
    if (events.length > 0) sessions.set(f, events);
  }
  return sessions;
}

export interface HttpServer {
  close(): void;
  port: number;
  url: string;
}

export interface HttpServerOptions {
  /** 生产模式：静态伺服的 web 构建产物目录（含 index.html）；不传=开发模式走 Vite 5173。 */
  staticDir?: string;
}

/** 记忆变更后异步重编译（fire-and-forget，不阻塞响应；无配置时是 no-op）。 */
function triggerRecompile(): void {
  void autoRecompile().catch(() => {});
}

/** 构建完整 HTTP 应用（API + 可选静态 SPA），不监听端口——
 *  dsh 插件用它把整个工作台桥接进 /dsh-hippo/app 前缀路由（同进程共用
 *  engine-holder 引用计数）；`hippo gui` 走 startHttpServer 监听。
 *  opts.autoTimer=false 时不启动自动蒸馏定时器（宿主生命周期自己管）。 */
export function buildHttpApp(opts: HttpServerOptions & { autoTimer?: boolean } = {}): express.Express {
  const app = express();
  app.use(cors({ origin: CORS_ORIGINS }));
  app.use(express.json({ limit: '50mb' }));

  // G2 读写分离：引擎按请求短持（engine-holder 引用计数），空闲即释放 zvec
  // 单写锁——`hippo gui` 常开不再锁死 dsh 插件；嵌入模型在模块级缓存不重载。

  // LLM 蒸馏判决注入：GUI 进程内的所有蒸馏路径（手动/自动循环）的候选
  // 都先过 llmRefine（模型来自设置页/llm.json），不可用时 refine 内部
  // 自动降级纯规则，绝不阻塞。
  void (async () => {
    try {
      const { loadLlmSettings: ls } = await import('./llm-config.js');
      const s = ls();
      if (s.apiKey || s.provider === 'ollama') {
        setDistillRefiner((cands) => llmRefine(cands, completeWithSettings));
      }
    } catch { /* 未配置 = 纯规则,不告警 */ }
  })();
  type EngineHandler = (req: express.Request, res: express.Response, held: HeldEngine) => void | Promise<void>;
  const ae = (fn: EngineHandler) => (req: express.Request, res: express.Response): void => {
    void withEngine(async (held) => fn(req, res, held))
      .catch((err: Error) => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
  };

  // 生产模式静态伺服（hippo gui 传 web/dist）；静态资源最先注册
  const spaIndex = opts.staticDir !== undefined ? join(opts.staticDir, 'index.html') : '';
  const hasStatic = spaIndex !== '' && existsSync(spaIndex);
  if (hasStatic) app.use(express.static(opts.staticDir!));

  // exportRecords returns Record<string,unknown>[] (transfer.ts is storage-
  // agnostic); compile.ts wants MemoryRecord[]. Shapes match — cast here.
  const compileRecords = (held: HeldEngine, proj?: string): MemoryRecord[] =>
    (exportRecords(held.engine.store as any, { project: proj }) as unknown as MemoryRecord[])
      .filter(r => !r.superseded_by); // 推翻链：编译只投影当前有效认知

  app.get('/api/stats', ae((_req, res, held) => {
    res.json(buildPayload(held.engine.store as any));
  }));

  app.get('/api/memories', ae((req, res, held) => {
    const { project, type, agent, limit, offset } = req.query;
    const filters = {
      project: project ? String(project) : undefined,
      type: type ? String(type) : undefined,
      agent: agent ? String(agent) : undefined,
    };
    const rows = listRecords(held.engine.store as never, {
      ...filters,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    // origin_ts = 原会话时间（L0 turns 里最后一轮的时间戳；时间线按"事情发生的时间"排，
    // 而非记忆写入的时间——否则批量导入的记忆全挤在导入当天）
    try {
      const times = sourceTimes();
      for (const r of rows) {
        const sid = String(r.source_id ?? '');
        if (sid && times.has(sid)) (r as Record<string, unknown>).origin_ts = times.get(sid);
      }
    } catch { /* sources 目录不可用则不带 origin_ts */ }
    // 带筛选后总数，分页页数用
    res.json({ memories: rows, total: countRecords(held.engine.store as never, filters) });
  }));

  // 批量相似边（图谱专用）：一次短持出 top-N 记忆的全图边，免去逐条 200 次 similar
  app.get('/api/memories/graph-edges', ae(async (req, res, held) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const threshold = Math.min(Number(req.query.threshold) || 0.7, 1);
    try {
      const records = (held.engine.store as any).scan().map(([r]: [MemoryRecord]) => r as MemoryRecord)
        .sort((a: MemoryRecord, b: MemoryRecord) => b.strength - a.strength)
        .slice(0, limit);
      const edges: { source: string; target: string; similarity: number }[] = [];
      for (const m of records) {
        const sim = await held.engine.similar(m.id, { limit: 6 });
        for (const h of sim) {
          if (h.similarity >= threshold && h.id !== m.id && m.id < h.id) {
            edges.push({ source: m.id, target: h.id, similarity: Number(h.similarity.toFixed(3)) });
          }
        }
      }
      const nodes = records.map((m: MemoryRecord) => ({ id: m.id, text: m.text, type: m.type, project: m.project, strength: m.strength }));
      res.json({ nodes, edges });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }));

  // 竞品迁移导入：POST /api/memories/import {raw, apply?} → 预览或执行
  app.post('/api/memories/import', ae(async (req, res, held) => {
    const { raw, apply, defaultProject } = req.body ?? {};
    if (typeof raw !== 'string' || raw.trim() === '') {
      res.status(400).json({ error: 'raw required' }); return;
    }
    try {
      const { parseImport, executeImport } = await import('./import-external.js');
      const preview = parseImport(raw, typeof defaultProject === 'string' ? defaultProject : 'global');
      if (preview.error) { res.status(400).json({ error: preview.error }); return; }
      if (apply === true) {
        const result = await executeImport(held.engine, preview.candidates);
        res.json({ ...result, preview: { total: preview.totalLines, recognized: preview.recognized, skipped: preview.skipped } });
      } else {
        // 预览模式：只返回前 20 条候选
        res.json({
          preview: { total: preview.totalLines, recognized: preview.recognized, skipped: preview.skipped },
          candidates: preview.candidates.slice(0, 20).map(c => ({ ...c, text: c.text.slice(0, 100) })),
        });
      }
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }));

  // 项目卡片：活跃度/记忆数/任务状态
  app.get('/api/projects/:name/card', ae(async (req, res, held) => {
    const name = String(req.params.name);
    try {
      const { projectCard } = await import('./project-card.js');
      const card = projectCard(name, held.engine, { lastUpdatedAt: Date.now() / 1000, count: 0 });
      res.json(card);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  // 系统健康状态（GUI 顶栏用）：自动蒸馏 + 待审队列 + 编译配置 + 最近编译
  app.get('/api/health', ae(async (_req, res, held) => {
    try {
      const auto = loadAutoSettings();
      const shelvedCount = listShelved().length;
      const { loadCompileConfig } = await import('./compile-config.js');
      const compileConfig = loadCompileConfig();
      const stats = await import('./dashboard.js').then(m => m.buildPayload(held.engine.store as never));
      res.json({
        autoDistill: {
          mode: auto.mode,
          threshold: auto.threshold,
          intervalMin: auto.intervalMin,
          lastRunAt: auto.lastRunAt ?? null,
          lastRun: auto.lastRun ?? null,
          running: auto.mode !== 'off',
        },
        shelvedQueue: shelvedCount,
        memoryCount: stats.total,
        compileTargets: compileConfig.targets.map(t => ({
          project: t.project,
          outPath: t.outPath,
          lastCompiledAt: t.lastCompiledAt,
          memoryCount: t.lastMemoryCount,
        })),
        dataDir: held.engine.store ? '~/.hippo' : 'unknown',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  // 记忆价值面板：按召回频次排序（accessed_at ≠ created_at = 被用过）

  app.get('/api/memories/value', ae((_req, res, held) => {
    try {
      const all = (held.engine.store as any).scan().map(([r]: [any]) => r) as Array<{
        id: string; text: string; type: string; project: string; strength: number;
        created_at: number; accessed_at: number; superseded_by?: string;
      }>;
      const now = Date.now() / 1000;
      const active = all.filter(r => !r.superseded_by);
      const used = active.filter(r => (r.accessed_at ?? 0) > (r.created_at ?? 0) + 1); // >1s 差 = 被 touch 过
      const neverUsed = active.filter(r => (r.accessed_at ?? 0) <= (r.created_at ?? 0) + 1);
      const staleDays = (r: typeof used[0]) => Math.floor((now - (r.created_at ?? 0)) / 86400);
      res.json({
        total: active.length,
        used: used.length,
        neverUsed: neverUsed.length,
        // 被召回最多的 top 20
        topUsed: used
          .sort((a, b) => (b.strength ?? 1) - (a.strength ?? 1))
          .slice(0, 20)
          .map(r => ({
            id: r.id, text: r.text.slice(0, 120), type: r.type, project: r.project,
            strength: r.strength ?? 1,
            lastAccessed: r.accessed_at,
            ageDays: staleDays(r),
          })),
        // 从未召回 + 超 30 天 = 退役候选
        retireCandidates: neverUsed
          .filter(r => staleDays(r) > 30)
          .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
          .slice(0, 50)
          .map(r => ({
            id: r.id, text: r.text.slice(0, 120), type: r.type, project: r.project,
            ageDays: staleDays(r),
          })),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));
  // ── H12 0.5 M5：记忆合并——选 2~3 条 LLM 合成一条（原条目 supersede 可逆）──
  app.post('/api/memories/merge', async (req, res) => {
    const { ids, project } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length < 2) {
      res.status(400).json({ error: 'ids array (≥2) required' }); return;
    }
    try {
      const { listRecords } = await import('./transfer.js');
      const { getRefinerBridge } = await import('./auto-distill-run.js');
      await withEngine(async ({ engine }) => {
        const rows = listRecords(engine.store as never, { includeSuperseded: false }) as Record<string, unknown>[];
        const texts: string[] = [];
        const validIds: string[] = [];
        for (const id of ids) {
          const r = rows.find(x => String(x.id) === String(id));
          if (r) { texts.push(String(r.text ?? '')); validIds.push(String(id)); }
        }
        if (validIds.length < 2) { res.status(400).json({ error: '有效记忆不足 2 条' }); return; }
        // LLM 合成
        const bridge = getRefinerBridge();
        let digest: string;
        if (bridge) {
          try {
            const NL = String.fromCharCode(10);
            digest = await bridge('把以下多条记忆合并成一条自包含的记忆（保留所有具体细节和技术名词，去掉重复）', texts.map((t, i) => `${i + 1}. ${t}`).join(NL));
            digest = digest.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          } catch { digest = texts.join('；'); }
        } else {
          digest = texts.join('；');
        }
        // 入库 + supersede
        const r = await engine.remember(digest, { type: 'lesson', project: project ?? 'merged', agent: 'merge' });
        for (const id of validIds) { await engine.markSuperseded(id, r.id); }
        res.json({ id: r.id, text: digest, merged: validIds.length, status: r.status });
      });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── H12 0.5 M2：冲突检测——sim≥0.80 的同项目记忆对中含否定/矛盾信号 ──
  app.get('/api/memories/conflicts', async (_req, res) => {
    try {
      const { listRecords } = await import('./transfer.js');
      const { searchSessions } = await import('../agents/session-index.js');
      await withEngine(async ({ engine }) => {
        const rows = listRecords(engine.store as never, { includeSuperseded: false }) as Record<string, unknown>[];
        const conflicts: Array<{ a: { id: string; text: string }; b: { id: string; text: string }; sim: number; project: string }> = [];
        // 按项目分组，组内两两 similar() 找高相似但文本方向相反的对
        const byProj = new Map<string, Record<string, unknown>[]>();
        for (const r of rows) {
          const proj = String(r.project ?? '');
          if (!byProj.has(proj)) byProj.set(proj, []);
          byProj.get(proj)!.push(r);
        }
        for (const [, mems] of byProj) {
          if (mems.length < 2) continue;
          for (let i = 0; i < mems.length; i++) {
            for (let j = i + 1; j < mems.length; j++) {
              const a = mems[i], b = mems[j];
              try {
                const sims = await engine.similar(String(a.id), { limit: 5 });
                const sim = sims.find(s => s.id === String(b.id))?.similarity ?? 0;
                if (sim < 0.75) continue;
                // 矛盾信号：两条中一条含否定词
                const NEG = /不用|不再|放弃|弃用|改用|换成了|never|instead of|no longer|deprecated|替代/i;
                const aNeg = NEG.test(String(a.text ?? ''));
                const bNeg = NEG.test(String(b.text ?? ''));
                if (aNeg !== bNeg && sim >= 0.75) {
                  conflicts.push({
                    a: { id: String(a.id), text: String(a.text ?? '').slice(0, 100) },
                    b: { id: String(b.id), text: String(b.text ?? '').slice(0, 100) },
                    sim: Math.round(sim * 100) / 100, project: String(a.project ?? ''),
                  });
                }
              } catch { /* 单对失败跳过 */ }
            }
          }
        }
        res.json({ conflicts: conflicts.slice(0, 50) });
      });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── H12 0.5：零召回清单（must be before :id to avoid capture）──
  app.get('/api/never-recalled', async (_req, res) => {
    try {
      const { listRecords } = await import('./transfer.js');
      await withEngine(async ({ engine }) => {
        const rows = listRecords(engine.store as never, { includeSuperseded: false }) as Record<string, unknown>[];
        const never = rows.filter(r =>
          r.accessed_at !== undefined && r.created_at !== undefined &&
          Math.abs((r.accessed_at as number) - (r.created_at as number)) < 1
        ).map(r => ({ id: r.id, text: r.text, type: r.type, project: r.project, agent: r.agent, created_at: r.created_at }));
        res.json({ total: rows.length, neverRecalled: never.length, items: never });
      });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.get('/api/memories/:id', ae(async (req, res, held) => {
    const got = await held.engine.store.get(String(req.params.id));
    if (!got) { res.status(404).json({ error: 'not found' }); return; }
    const rec = got[0];
    // 推翻链（演化视图）：向后追新版，向前找它取代了谁；每环可回放 source
    const chain: { newer?: { id: string; text: string; created_at: number }; older?: { id: string; text: string; created_at: number } } = {};
    try {
      let cur = rec;
      for (let i = 0; i < 10 && cur.superseded_by; i++) {
        const nxt = await held.engine.store.get(cur.superseded_by);
        if (!nxt) break;
        cur = nxt[0];
      }
      if (cur !== rec) chain.newer = { id: cur.id, text: cur.text, created_at: cur.created_at };
      const all = (held.engine.store as any).scan().map(([r]: [any]) => r) as MemoryRecord[];
      const replaced = all.find(r => r.superseded_by === rec.id);
      if (replaced) chain.older = { id: replaced.id, text: replaced.text, created_at: replaced.created_at };
    } catch { /* 链构造失败不影响详情 */ }
    res.json({ ...rec, chain });
  }));

  // 推翻链手动操作：标记取代 / 恢复
  app.post('/api/memories/:id/supersede', ae(async (req, res, held) => {
    const { newId } = req.body ?? {};
    if (typeof newId !== 'string') { res.status(400).json({ error: 'newId required' }); return; } // newId='' 表示恢复（清标记）
    try {
      // newId='' 经 markSuperseded(id,'') 走 upsert 清空旁挂——用于恢复误标记
      const ok = await held.engine.markSuperseded(String(req.params.id), newId);
      triggerRecompile();
      res.json({ ok });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }));

  app.get('/api/memories/:id/similar', ae(async (req, res, held) => {
    const limit = Math.min(Number(req.query.limit) || 4, 20);
    try {
      const hits = await held.engine.similar(String(req.params.id), { limit });
      res.json(hits);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  // 记忆 → 来源会话（G2 双向跳转）：按 L0 source_id 反查所属会话。
  app.get('/api/memories/:id/source-session', ae(async (req, res, held) => {
    const got = await held.engine.store.get(String(req.params.id));
    if (!got) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ sourceId: got[0].source_id, sessionId: findSessionBySource(got[0].source_id) });
  }));

  app.post('/api/memories', ae(async (req, res, held) => {
    const { text, type, project, agent } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    try {
      const result = await held.engine.remember(text, {
        type: type as MemoryType, project, agent,
      });
      triggerRecompile();
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  app.patch('/api/memories/:id', ae(async (req, res, held) => {
    const { text, type, project } = req.body ?? {};
    try {
      const result = await held.engine.update(String(req.params.id), {
        text: typeof text === 'string' ? text : undefined,
        type: type as MemoryType | undefined,
        project: typeof project === 'string' ? project : undefined,
      });
      triggerRecompile();
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  app.delete('/api/memories/:id', ae(async (req, res, held) => {
    const ok = await held.engine.forget(String(req.params.id));
    if (ok) triggerRecompile();
    res.status(ok ? 200 : 404).json({ deleted: ok });
  }));

  app.post('/api/recall', ae(async (req, res, held) => {
    const { query, project, limit } = req.body ?? {};
    if (typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'query required' });
      return;
    }
    // recall() 默认只搜 global 桶；web UI 留空项目=全项目——取全部项目分别召回后按分并。
    const limitN = typeof limit === 'number' ? limit : 10;
    let hits;
    if (project && project !== 'all') {
      hits = await held.engine.recall(query, { project, limit: limitN });
    } else {
      const allProjects = Object.keys(buildPayload(held.engine.store as any).byProject);
      const perProject = Math.max(1, Math.ceil(limitN / Math.max(1, allProjects.length)));
      const merged: RecallHit[] = [];
      for (const proj of allProjects) {
        merged.push(...await held.engine.recall(query, { project: proj, limit: perProject }));
      }
      merged.sort((a, b) => b.score - a.score);
      hits = merged.slice(0, limitN);
    }
    // 补 created_at（结果卡片显示日期用）
    try {
      const byId = new Map((held.engine.store as any).scan().map(([r]: [any]) => [r.id, r]));
      for (const h of hits as any[]) {
        const r = byId.get(h.id) as { created_at?: number } | undefined;
        if (r) h.created_at = r.created_at ?? null;
      }
    } catch { /* 取不到就不带 */ }
    res.json(hits);
  }));

  app.post('/api/distill/preview', (req, res) => {
    const { transcript, project } = req.body ?? {};
    if (typeof transcript !== 'string' || !transcript.trim()) {
      res.status(400).json({ error: 'transcript required' });
      return;
    }
    try {
      const turns = [];
      for (const entry of parseJsonl(transcript)) turns.push(...entryToTurns(entry));
      const candidates = extractCandidates(turns, { projectOverride: project });
      res.json({ turns: turns.length, candidates });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/distill/apply', ae(async (req, res, held) => {
    const { candidates, agent } = req.body ?? {};
    if (!Array.isArray(candidates)) {
      res.status(400).json({ error: 'candidates array required' });
      return;
    }
    try {
      const result = await runDistill(held.engine, candidates as Candidate[], {
        apply: true,
        agent: typeof agent === 'string' ? agent : 'distill:web',
      });
      triggerRecompile();
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  // skill 线阶段一：纯规则提取修正模式（失败→修正对）
  app.get('/api/skills/extract', async (_req, res) => {
    try {
      const { extractSkillCandidates } = await import('./skill-extract.js');
      res.json(extractSkillCandidates());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/patterns', (req, res) => {
    const { dir, limit, minSessions, minCount, top } = req.query;
    const sessions = loadSessions(dir ? String(dir) : undefined, limit ? Number(limit) : 0);
    let patterns = minePatterns(sessions, {
      minSessions: minSessions ? Number(minSessions) : 2,
      minCount: minCount ? Number(minCount) : 3,
    });
    patterns = scorePatterns(patterns);
    const topN = top ? Number(top) : 20;
    res.json({
      scanned: sessions.size,
      total: findTranscripts(dir ? String(dir) : undefined, 0).length,
      patterns: patterns.slice(0, topN).map(patternToDict),
    });
  });

  app.post('/api/patterns/export', (req, res) => {
    const { dir, top } = req.body ?? {};
    if (typeof dir !== 'string') {
      res.status(400).json({ error: 'dir required' });
      return;
    }
    const sessions = loadSessions(undefined, 0);
    let patterns = scorePatterns(minePatterns(sessions, {}));
    const topN = typeof top === 'number' ? top : 5;
    patterns = patterns.slice(0, topN);
    try {
      const exported = exportSkills(patterns as Pattern[], dir);
      res.json({ exported });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Compile preview — render the markdown without writing any file. Returns
  // { files, memoryCount, preview } where preview maps each output filename to
  // its rendered content.
  app.post('/api/compile/preview', ae(async (req, res, held) => {
    const { target, project, minStrength, indexMode } = req.body ?? {};
    if (!TARGETS.includes(target) && target !== 'all') {
      res.status(400).json({ error: `target must be one of ${TARGETS.join(', ')}, all` });
      return;
    }
    try {
      const records = compileRecords(held, project || undefined);
      const targets: CompileTarget[] = target === 'all' ? TARGETS : [target];
      const minStr = typeof minStrength === 'number' ? minStrength : 1;
      const preview: Record<string, string> = {};
      let memoryCount = 0;
      for (const t of targets) {
        const groups = groupMemories(records, { project: project || undefined, minStrength: minStr });
        memoryCount = Math.max(memoryCount,
          groups.always.length + groups.onDemand.length
          + [...groups.byProject.values()].reduce((s, l) => s + l.length, 0));
        if (t === 'cursor') {
          for (const rule of renderCursorRules(groups)) preview[rule.filename] = rule.content;
        } else if (t === 'json') {
          // JSON 目标：程序化消费格式
          preview[defaultOutPath(t)] = JSON.stringify({
            generatedAt: new Date().toISOString(),
            project: project || 'global',
            currentState: { tasks: (await import('./task-context.js')).tasksForProject(project || '') },
            memories: {
              conventions: groups.always.map(r => ({ type: r.type, text: r.text, strength: r.strength })),
              projectFacts: Object.fromEntries([...groups.byProject.entries()].map(([k, v]) => [k, v.map(r => r.text)])),
              lessons: groups.onDemand.map(r => r.text),
            },
          }, null, 2);
        } else {
          // agents-md / claude-md / copilot share the same body, different filename
          preview[defaultOutPath(t)] = indexMode === true ? renderIndexMd(groups) : renderAgentsMd(groups);
        }
      }
      res.json({ memoryCount, preview });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  // Compile write — render AND write the files. outPath overrides the default
  // per-target path (file for agents-md/claude-md, dir for cursor). Files are
  // written relative to the server's cwd (i.e. where `hippo ui` was launched).
  app.post('/api/compile', ae(async (req, res, held) => {
    const { target, project, minStrength, outPath, indexMode } = req.body ?? {};
    if (!TARGETS.includes(target) && target !== 'all') {
      res.status(400).json({ error: `target must be one of ${TARGETS.join(', ')}, all` });
      return;
    }
    try {
      const records = compileRecords(held, project || undefined);
      const targets: CompileTarget[] = target === 'all' ? TARGETS : [target];
      const minStr = typeof minStrength === 'number' ? minStrength : 1;
      const files: string[] = [];
      let memoryCount = 0;
      for (const t of targets) {
        const r = compileTarget(t, records, {
          indexMode: indexMode !== false,
          outPath: outPath !== undefined ? outPath : defaultOutPath(t),
        });
        // 编译自动化：记住配置，自动蒸馏后重编
        if (outPath !== undefined) {
          try {
            const { recordCompile } = await import('./compile-config.js');
            recordCompile(project || 'global', outPath, t, r.memoryCount);
          } catch { /* 记录失败不影响编译 */ }
        }
        files.push(...r.files);
        memoryCount = Math.max(memoryCount, r.memoryCount);
      }
      res.json({ files, memoryCount });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  // ── H7 M5：handoff 收件箱（工作台 ⇪ 按钮 / skill 取件共用）──
  app.get('/api/handoff/inbox', async (_req, res) => {
    const { listInbox } = await import('./handoff-inbox.js');
    res.json({ pending: listInbox() });
  });

  app.post('/api/handoff/push', async (req, res) => {
    const { sessionId, to } = req.body ?? {};
    if (typeof sessionId !== 'string' || sessionId === '') {
      res.status(400).json({ error: 'sessionId required' });
      return;
    }
    try {
      const { pushHandoff } = await import('./handoff-inbox.js');
      const item = pushHandoff(sessionId, typeof to === 'string' ? { to } : {});
      res.json({ id: item.id, title: item.from.title, candidates: item.candidates.length, tasks: item.activeTasks.length, changed: item.git.changed.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/handoff/load', async (req, res) => {
    const { id } = req.body ?? {};
    if (typeof id !== 'string' || id === '') {
      res.status(400).json({ error: 'id required' });
      return;
    }
    try {
      const { loadHandoff } = await import('./handoff-inbox.js');
      const { text } = loadHandoff(id);
      res.json({ text });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // ── H12 M-01：tier 老化归档（诊断页入口）──
  app.get('/api/tier-aging', async (_req, res) => {
    try {
      const { tierAge } = await import('./tier-aging.js');
      const { getRefinerBridge } = await import('./auto-distill-run.js');
      await withEngine(async ({ engine }) => {
        const report = await tierAge(engine as never, getRefinerBridge(), { apply: false });
        res.json({ groupsFound: report.groupsFound, groups: report.groups });
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/tier-aging', async (_req, res) => {
    try {
      const { tierAge } = await import('./tier-aging.js');
      const { getRefinerBridge } = await import('./auto-distill-run.js');
      await withEngine(async ({ engine }) => {
        const report = await tierAge(engine as never, getRefinerBridge(), { apply: true });
        res.json({ groupsFound: report.groupsFound, digestsCreated: report.digestsCreated, archived: report.archived, llmUsed: report.llmUsed });
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // agent 贡献分析（按 agent 统计：总数/类型分布/平均强度/零召回占比）
  app.get('/api/stats/agents', async (_req, res) => {
    try {
      const { listRecords } = await import('./transfer.js');
      await withEngine(async ({ engine }) => {
        const rows = listRecords(engine.store as never, { includeSuperseded: false }) as Record<string, unknown>[];
        const byAgent = new Map<string, { agent: string; total: number; byType: Record<string, number>; avgStrength: number; neverRecalled: number }>();
        for (const r of rows) {
          const a = String(r.agent ?? 'unknown').replace(/^import:/, '');
          let e = byAgent.get(a);
          if (!e) { e = { agent: a, total: 0, byType: {}, avgStrength: 0, neverRecalled: 0 }; byAgent.set(a, e); }
          e.total++;
          const t = String(r.type ?? 'fact');
          e.byType[t] = (e.byType[t] ?? 0) + 1;
          if (r.accessed_at !== undefined && r.created_at !== undefined && Math.abs((r.accessed_at as number) - (r.created_at as number)) < 1) e.neverRecalled++;
        }
        const out = [...byAgent.values()].map(e => ({ ...e, avgStrength: 0 }));
        res.json({ agents: out });
      });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // 项目残留检测（记忆归属的 project 在常见工作区路径下找不到对应目录）
  app.get('/api/stats/project-residue', async (_req, res) => {
    try {
      const { listRecords } = await import('./transfer.js');
      const { existsSync } = await import('node:fs');
      await withEngine(async ({ engine }) => {
        const rows = listRecords(engine.store as never, { includeSuperseded: false }) as Record<string, unknown>[];
        const byProject = new Map<string, number>();
        for (const r of rows) {
          const proj = String(r.project ?? '');
          if (proj && proj !== 'global') byProject.set(proj, (byProject.get(proj) ?? 0) + 1);
        }
        const searchRoots = ['D:/coding', 'C:/Users/20369'];
        const residue = [...byProject.entries()]
          .filter(([proj]) => proj.length > 2 && !searchRoots.some(root => existsSync(join(root, proj))))
          .map(([proj, count]) => ({ project: proj, memoryCount: count }))
          .sort((a, b) => b.memoryCount - a.memoryCount);
        res.json({ totalProjects: byProject.size, residue });
      });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // 编译配置管理：查看 / 删除自动重编译的目标
  app.get('/api/compile-config', async (_req, res) => {
    const { getCompileTargets } = await import('./compile-config.js');
    res.json({ targets: getCompileTargets() });
  });

  app.delete('/api/compile-config', async (req, res) => {
    const { project, outPath } = req.query;
    if (typeof project !== 'string' || typeof outPath !== 'string') {
      res.status(400).json({ error: 'project and outPath query params required' });
      return;
    }
    const { removeCompileConfig, getCompileTargets } = await import('./compile-config.js');
    removeCompileConfig(project, outPath);
    res.json({ targets: getCompileTargets() });
  });

  app.get('/api/sources', (_req, res) => {
    res.json(listSources());
  });

  app.get('/api/sources/:id', (req, res) => {
    const blob = loadSource(req.params.id);
    if (!blob) { res.status(404).json({ error: 'not found' }); return; }
    res.json(blob);
  });

  app.get('/api/doctor', ae(async (_req, res, held) => {
    res.json(await diagnose(held.engine.store as any));
  }));

  app.post('/api/doctor/rebuild', async (_req, res) => {
    // rebuild needs exclusive access to drop + recreate the store, but this
    // server is holding zvec's single-writer lock for the live engine. Doing
    // it in-place would race every concurrent request. Route the user to the
    // CLI, which runs in its own process.
    res.status(409).json({
      error: 'rebuild requires exclusive access to the store, but this server is holding the lock. Stop the server and run `hippo doctor --rebuild` from a terminal.',
    });
  });

  // ── 会话端点（G1：看会话 / 提取会话 / 单会话蒸馏）──────────────
  // 列表永远走实时发现（毫秒级、不依赖索引进度）；详情/搜索/蒸馏走索引，
  // 未命中索引时回退实时解析。启动时后台预热一次增量同步。
  let sessionIndexSynced = false;
  let lastSyncAt = 0;
  const runSync = (): void => {
    const r = syncSessionIndex();
    sessionIndexSynced = true;
    lastSyncAt = Date.now();
    console.log(`[sessions] 索引同步完成: +${r.added} 新增 ~${r.updated} 更新 -${r.removed} 移除 =${r.unchanged} 不变（共 ${r.total}）`);
  };
  const warmup = setTimeout(() => {
    try {
      runSync();
    } catch (err) {
      console.error('[sessions] 索引同步失败:', (err as Error).message);
    }
  }, 50);
  warmup.unref(); // 不为预热拖住进程退出

  // G2 定时自动增量：10 分钟一轮（会话索引是独立 sqlite，不占 zvec 锁）。
  const syncTimer = setInterval(() => {
    try { runSync(); } catch { /* 单轮失败下轮再试 */ }
  }, 10 * 60 * 1000);
  syncTimer.unref();
  // 停止钩子挂在 app 上：startHttpServer 的 close() 用（桥接模式随宿主进程走）
  ;(app as unknown as { __hippoStopSessionSync?: () => void }).__hippoStopSessionSync = () => clearInterval(syncTimer);

  /** 详情/导出/蒸馏共用的取 Turn 流：优先索引，未命中回退实时解析。 */
  const loadSessionFull = (id: string): { session: IndexedSession; turns: Turn[]; live: boolean } | null => {
    const indexed = getIndexedSession(id);
    if (indexed !== null && indexed.turns.length > 0) {
      return { ...indexed, live: false };
    }
    const ref = discoverAll().find((s) => s.id === id);
    if (!ref) return indexed === null ? null : { ...indexed, live: false };
    let turns: Turn[] = [];
    try { turns = parseSession(ref.agent, ref.id); } catch { turns = []; }
    return {
      session: {
        id: ref.id, agent: ref.agent, title: ref.title, cwd: ref.cwd,
        project: cwdToProject(ref.cwd), updatedAt: Math.round(ref.updatedAt), turnCount: turns.length,
      },
      turns,
      live: true,
    };
  };

  // ── 团队记忆（T2）：分诊视图 + 晋升/退役审批 + 扫描 + 条目 ──────────
  app.get('/api/team/triage', (_req, res) => {
    try { res.json(triage()); } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ── 自动蒸馏（AD）：设置 / 立即跑 / 搁置队列 ──────────
  app.get('/api/auto-distill', (_req, res) => {
    const st = loadAutoSettings();
    res.json({ settings: st, shelvedCount: listShelved().length });
  });

  app.post('/api/auto-distill', (req, res) => {
    const { settings } = req.body ?? {};
    if (typeof settings !== 'object' || settings === null) {
      res.status(400).json({ error: 'settings required' }); return;
    }
    const merged: AutoDistillSettings = { ...loadAutoSettings(), ...settings };
    if (!['off', 'review', 'auto'].includes(merged.mode)) merged.mode = 'off';
    merged.threshold = Math.min(1, Math.max(0.5, Number(merged.threshold) || 0.75));
    merged.intervalMin = Math.min(1440, Math.max(5, Number(merged.intervalMin) || 15));
    saveAutoSettings(merged);
    res.json({ settings: merged });
  });

  // ── LLM 模型设置（模型设置页后端）──────────────────────
  app.get('/api/llm-settings', (_req, res) => {
    const s = loadLlmSettings();
    res.json({ ...s, apiKey: maskKey(s.apiKey), hasKey: s.apiKey !== '', presets: PRESETS });
  });
  app.post('/api/llm-settings', (req, res) => {
    const b = req.body ?? {};
    const cur = loadLlmSettings();
    const merged = {
      provider: ['minimax', 'ollama', 'custom'].includes(b.provider) ? b.provider : cur.provider,
      baseUrl: String(b.baseUrl ?? cur.baseUrl).trim() || cur.baseUrl,
      model: String(b.model ?? cur.model).trim() || cur.model,
      // 空字符串 = 保持原 key（前端掩码回显时不丢）;显式 null = 清除
      apiKey: b.apiKey === null ? '' : (typeof b.apiKey === 'string' && b.apiKey.trim() !== '' && !b.apiKey.startsWith('****') ? b.apiKey.trim() : cur.apiKey),
    };
    saveLlmSettings(merged);
    res.json({ ...merged, apiKey: maskKey(merged.apiKey), hasKey: merged.apiKey !== '' });
  });
  app.post('/api/llm-settings/test', async (_req, res) => {
    try {
      const t0 = Date.now();
      const text = await completeWithSettings('reply with exactly: OK', 'ping', { timeoutMs: 30_000 });
      res.json({ ok: true, ms: Date.now() - t0, sample: text.slice(0, 60) });
    } catch (err) {
      res.status(502).json({ ok: false, error: (err as Error).message });
    }
  });

  // 睡眠整合（P0-3）：dry-run 出报告，apply 才动手（合并近重复/清孤儿源/过期搁置）
  app.post('/api/sleep', ae(async (req, res, held) => {
    try { res.json(await runSleep(held.engine, { apply: req.body?.apply === true })); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }));

  app.post('/api/auto-distill/run', ae(async (_req, res) => {
    try { res.json(await runAutoDistillOnce()); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }));

  app.get('/api/shelved', (_req, res) => {
    res.json(listShelved().map((s, i) => ({ index: i, ...s })));
  });

  app.post('/api/shelved/apply', ae(async (req, res, held) => {
    const { indices } = req.body ?? {};
    if (!Array.isArray(indices) || indices.length === 0) {
      res.status(400).json({ error: 'indices required' }); return;
    }
    const all = listShelved();
    const cands = indices.filter(i => all[i]).map(i => ({ ...all[i].candidate }));
    if (cands.length === 0) { res.status(404).json({ error: 'no such items' }); return; }
    const r = await runDistill(held.engine, cands, { apply: true, agent: 'shelved:review' });
    takeShelved(indices);
    triggerRecompile();
    res.json(r);
  }));

  app.post('/api/shelved/discard', (req, res) => {
    const { indices } = req.body ?? {};
    if (!Array.isArray(indices) || indices.length === 0) {
      res.status(400).json({ error: 'indices required' }); return;
    }
    res.json({ remaining: takeShelved(indices) });
  });

  // ── 文件夹浏览（编译输出路径选择用）──────────────────
  let availableDrives: string[] | null = null; // 盘符探测结果缓存（探测光驱很慢）
  app.get('/api/fs/list', (req, res) => {
    const dirPath = String(req.query.path ?? '');
    try {
      const target = dirPath === '' ? homedir() : dirPath;
      let entries = readdirSync(target, { withFileTypes: true })
        .filter((e: { isDirectory: () => boolean; name: string }) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => ({ name: e.name, path: join(target, e.name) }))
        .slice(0, 100); // 防止大目录返回过多
      let parent = dirname(target);
      if (parent === target) {
        // 已到盘符根（Windows）/文件系统根（POSIX）：无法再上级，
        // Windows 下把其他可用盘符列进来，浏览器才能跨盘走到 D:/F:。
        // 盘符探测对光驱/读卡器可能要几秒，进程内只探一次。
        parent = '';
        if (process.platform === 'win32') {
          if (!availableDrives) {
            const drives: string[] = [];
            for (let c = 65; c <= 90; c++) {
              const letter = String.fromCharCode(c);
              try {
                readdirSync(`${letter}:\\`);
                drives.push(letter);
              } catch { /* 盘符不存在 */ }
            }
            availableDrives = drives;
          }
          const cur = target.slice(0, 2).toUpperCase();
          const others = availableDrives.filter((l) => `${l}:` !== cur)
            .map((l) => ({ name: `${l}:`, path: `${l}:\\` }));
          entries = [...others, ...entries];
        }
      }
      res.json({ current: target, parent, entries });
    } catch (err) {
      res.status(400).json({ error: `无法读取目录：${(err as Error).message}` });
    }
  });

  // ── 生活流（life K0）：居民/频道/消息 ──────────────────
  app.get('/api/life/residents', (_req, res) => {
    try { res.json(listResidents()); } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.post('/api/life/residents', (req, res) => {
    const { name, persona, chattiness } = req.body ?? {};
    if (typeof name !== 'string' || typeof persona !== 'string' || persona.trim() === '') {
      res.status(400).json({ error: 'name 和 persona 必填' }); return;
    }
    try {
      res.json(createResident(name, persona.trim(), { chattiness: typeof chattiness === 'number' ? chattiness : undefined }));
    } catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });

  app.delete('/api/life/residents/:name', (req, res) => {
    res.json({ deleted: deleteResident(String(req.params.name)) });
  });

  app.get('/api/life/channels', (_req, res) => {
    try { res.json(listChannels()); } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.post('/api/life/channels', (req, res) => {
    const { id, topic, members } = req.body ?? {};
    if (typeof id !== 'string' || typeof topic !== 'string' || topic.trim() === '') {
      res.status(400).json({ error: 'id 和 topic 必填' }); return;
    }
    try {
      res.json(createChannel(id, topic.trim(), Array.isArray(members) ? members.map(String) : []));
    } catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });

  app.delete('/api/life/channels/:id', (req, res) => {
    try { res.json(deleteChannel(String(req.params.id))); } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // 居民协作：获取下一个该说话的居民 + 完整上下文（引擎侧不调 LLM，由调用方生成）
  app.post('/api/life/channels/:id/relay/next', (req, res) => {
    const channelId = String(req.params.id)
    const ch = getChannel(channelId)
    if (ch === null) { res.status(404).json({ error: '频道不存在' }); return; }
    const members = ch.members.filter(m => m !== 'user')
    if (members.length < 2) { res.status(400).json({ error: '至少需要 2 个居民才能接力' }); return; }
    // 轮转：最后说话的居民 → 下一个
    const msgs = readMessages(channelId, 0, 50)
    const lastResident = [...msgs].reverse().find(m => m.author.kind === 'resident')
    const lastIdx = lastResident ? members.indexOf((lastResident.author as { name: string }).name) : -1
    const nextIdx = (lastIdx + 1) % members.length
    const next = members[nextIdx]
    const resident = getResident(next)
    if (resident === null) { res.status(404).json({ error: `居民「${next}」不存在` }); return; }
    // 上下文：频道最近 15 条消息（含其他居民的发言）
    const recent = msgs.slice(-15)
    res.json({
      next: { name: next, persona: resident.persona },
      context: recent.map(m => ({
        author: (m.author as { name?: string }).name ?? m.author.kind,
        kind: m.author.kind,
        text: m.text.slice(0, 200),
        at: m.at,
      })),
      channelTopic: ch.topic,
    })
  })

  app.get('/api/life/channels/:id/messages', (req, res) => {
    const since = Number(req.query.since) || 0;
    try { res.json(readMessages(String(req.params.id), since)); } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.post('/api/life/channels/:id/messages', (req, res) => {
    const { text, author } = req.body ?? {};
    if (typeof text !== 'string' || text.trim() === '') {
      res.status(400).json({ error: 'text 必填' }); return;
    }
    const kind = author?.kind === 'resident' ? 'resident' : 'user';
    try {
      // K0：消息只入账本（用户侧可见）；K1 起唤醒居民生成 reply
      res.json(appendMessage(String(req.params.id), { kind, name: String(author?.name ?? 'user') }, text.trim()));
    } catch (err) { res.status(404).json({ error: (err as Error).message }); }
  });

  app.get('/api/life/channels/:id/bookmark/:resident', (req, res) => {
    res.json({ seq: readBookmark(String(req.params.id), String(req.params.resident)) });
  });

  // T4：运行一个进化周期（衰减→退役候选→预判卡→报告）
  app.post('/api/team/cycle', async (req, res) => {
    const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
    if (teamId === '') { res.status(400).json({ error: 'teamId required' }); return; }
    try { res.json(await runCycle(teamId)); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // T3：MD 投影下载（可再生视图；账本是真相源）
  app.get('/api/team/export', (_req, res) => {
    try {
      const md = renderTeamMemoryMarkdown();
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="team-memory.md"');
      res.send(md);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.get('/api/team/entries', (_req, res) => {
    try { res.json(foldLedger()); } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.post('/api/team/scan', async (_req, res) => {
    try {
      const dump = readTeamEvents();
      if (dump.events.length === 0) {
        res.json({ note: '本机无团队事件（需 harness rc.8+ 并跑过 agent team）', reports: [] });
        return;
      }
      const byTeam = new Map<string, Parameters<typeof distillTeamEvents>[0]>();
      for (const ev of dump.events) {
        const list = byTeam.get(ev.teamId) ?? [];
        list.push(ev);
        byTeam.set(ev.teamId, list);
      }
      const reports = [];
      for (const events of byTeam.values()) reports.push(await distillTeamEvents(events, { apply: true }));
      res.json({ teams: byTeam.size, reports });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.post('/api/team/promotion/:id', async (req, res) => {
    const { action, mergedText } = req.body ?? {};
    if (action !== 'promoted' && action !== 'ignored' && action !== 'kept-private') {
      res.status(400).json({ error: "action must be 'promoted' | 'ignored' | 'kept-private'" });
      return;
    }
    try {
      const r = await resolvePromotion(String(req.params.id), action, typeof mergedText === 'string' ? mergedText : undefined);
      res.status(r.ok ? 200 : 409).json(r);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.post('/api/team/retire/:id', (req, res) => {
    const { action, reason } = req.body ?? {};
    if (action !== 'retire' && action !== 'keep') {
      res.status(400).json({ error: "action must be 'retire' | 'keep'" });
      return;
    }
    try {
      const r = resolveRetirement(String(req.params.id), action, typeof reason === 'string' ? reason : undefined);
      res.status(r.ok ? 200 : 409).json(r);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // 索引状态（GUI 状态栏"上次同步 N 分钟前"用）
  app.get('/api/sessions/status', (_req, res) => {
    res.json({ synced: sessionIndexSynced, lastSyncAt, ...indexStats() });
  });

  // 手动触发同步（POST body 可带 {}；首次全量 ~25s，之后毫秒级）
  app.post('/api/sessions/sync', (_req, res) => {
    try {
      runSync();
      res.json({ ...indexStats(), lastSyncAt });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 会话搜索（H11 M-A）：FTS 关键字 + 向量语义 RRF 融合（嵌入源随引擎注入；
  // LLM 语义嵌入不可用时自动退化为纯关键字）。惰性补向量在请求内完成，
  // 首次全量较慢（每会话一次嵌入），之后走缓存。
  app.get('/api/sessions/search', async (req, res) => {
    let q = String(req.query.q ?? '');
    const agent = req.query.agent ? String(req.query.agent) : undefined;
    // H12 M4：搜索语法 type:xxx project:xxx keyword → 前缀过滤
    let typeFilter: string | undefined;
    let projectFilter: string | undefined;
    const typeMatch = q.match(/type:(\S+)/);
    if (typeMatch) { typeFilter = typeMatch[1]; q = q.replace(typeMatch[0], '').trim(); }
    const projMatch = q.match(/project:(\S+)/);
    if (projMatch) { projectFilter = projMatch[1]; q = q.replace(projMatch[0], '').trim(); }
    if (!sessionIndexSynced) {
      try { syncSessionIndex(); sessionIndexSynced = true; } catch { /* 搜索降级为空结果 */ }
    }
    try {
      const { searchSessionsHybrid } = await import('../agents/session-index.js');
      const { withEngine } = await import('./engine-holder.js');
      // withEngine 确保引擎已开（嵌入器在 openEngine 时接线）
      const hits = await withEngine((held) => searchSessionsHybrid(q, { agent, type: typeFilter, project: projectFilter }));
      res.json(hits);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 会话列表：实时发现 + 索引 turnCount 富化（turnCount=null 表示尚未入索引）
  app.get('/api/sessions', (req, res) => {
    const { agent, project, since, until, limit, offset } = req.query;
    // 列表源头是实时发现——被删除（.hippoignore）的会话这里也要过滤，否则删完又出现
    const ignore = loadIgnoreRules();
    let refs = discoverAll().filter((r) => !ignore.isIgnored(
      { title: r.title, cwd: r.cwd, agent: r.agent, id: r.id, project: cwdToProject(r.cwd) }));
    if (agent) refs = refs.filter((r) => r.agent === String(agent));
    if (project) refs = refs.filter((r) => cwdToProject(r.cwd) === String(project));
    if (since) refs = refs.filter((r) => r.updatedAt >= Number(since));
    if (until) refs = refs.filter((r) => r.updatedAt <= Number(until));
    const counts = turnCountMap();
    const distilled = distilledCountMap();
    const items = refs.map((r) => ({
      id: r.id,
      agent: r.agent,
      title: r.title,
      cwd: r.cwd,
      project: cwdToProject(r.cwd),
      updatedAt: Math.round(r.updatedAt),
      fingerprint: r.fingerprint,
      turnCount: counts.get(r.id) ?? null,
      distilled: distilled.get(r.id) ?? 0,
    }));
    const off = Math.max(Number(offset) || 0, 0);
    const size = Math.min(Math.max(Number(limit) || 50, 1), 500);
    res.json({ total: items.length, indexed: sessionIndexSynced, sessions: items.slice(off, off + size) });
  });

  // 单会话导出（下载）。:id 是 encodeURIComponent 后的适配器 id（含反斜杠的文件路径也没问题）
  const buildExport = (format: string, full: { session: IndexedSession; turns: Turn[] }) =>
    format === 'json' ? renderSessionJson(full.session, full.turns) : renderSessionMarkdown(full.session, full.turns);

  app.get('/api/sessions/:id/export', (req, res) => {
    const format = String(req.query.format ?? 'md');
    if (format !== 'md' && format !== 'json') {
      res.status(400).json({ error: 'format must be md | json' });
      return;
    }
    const full = loadSessionFull(req.params.id);
    if (full === null) { res.status(404).json({ error: 'session not found' }); return; }
    const filename = `${safeFileStem(full.session)}.${format}`;
    res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buildExport(format, full));
  });

  // 批量导出到目录（不做 zip：本地目录即交付物，避免引打包依赖）
  app.post('/api/sessions/export', (req, res) => {
    const { agent, project, format = 'md', outDir } = req.body ?? {};
    if (format !== 'md' && format !== 'json') {
      res.status(400).json({ error: 'format must be md | json' });
      return;
    }
    let refs = discoverAll();
    if (typeof agent === 'string' && agent !== '') refs = refs.filter((r) => r.agent === agent);
    if (typeof project === 'string' && project !== '') refs = refs.filter((r) => cwdToProject(r.cwd) === project);
    if (refs.length === 0) { res.json({ dir: '', count: 0, files: [] }); return; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = typeof outDir === 'string' && outDir !== '' ? outDir : join(dataDir(), 'exports', `${stamp}-${refs.length}`);
    try {
      mkdirSync(dir, { recursive: true });
      const files: string[] = [];
      for (const ref of refs) {
        const full = loadSessionFull(ref.id);
        if (full === null || full.turns.length === 0) continue;
        const name = `${safeFileStem(full.session)}.${format}`;
        writeFileSync(join(dir, name), buildExport(format, full), 'utf8');
        files.push(name);
      }
      res.json({ dir, count: files.length, files });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 删除会话：索引行 + ignore 防复活；?deleteSource=true 连源文件（file 类）
  app.delete('/api/sessions/:id', (req, res) => {
    const id = String(req.params.id);
    const deleteSource = req.query.deleteSource === 'true';
    try {
      const r = deleteSession(id, { deleteSource });
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 单会话蒸馏：预览(apply=false)/入库(apply=true)，复用引擎 distill 与 .hippoignore 排除
  // 强制重蒸馏：删该会话旧产物 → 重跑（AD-4）
  app.post('/api/sessions/:id/redistill', ae(async (req, res, held) => {
    const id = String(req.params.id);
    const full = loadSessionFull(id);
    if (full === null) { res.status(404).json({ error: 'session not found' }); return; }
    try {
      // 先清该会话已蒸馏的记忆（source_id 关联的）
      const all = (held.engine.store as any).scan().map(([r]: [any]) => r);
      const removed = [];
      for (const r of all) {
        if (r.source_id && full.turns.length > 0) {
          // 该记忆来自某个 source；查 source 归属会话是否为当前
          try {
            const src = await import('./sources.js');
            const blob = src.loadSource(r.source_id);
            // L0 blob 无会话 id，按 project+时间窗匹配太脆——用 session_distills 表
          } catch { /* 尽力 */ }
        }
      }
      // 简化方案：重跑蒸馏（fingerprint 变更会自然触发重提取；旧记忆保留，新候选走去重三档）
      const candidates = extractCandidates(full.turns, { projectOverride: full.session.project });
      const result = await runDistill(held.engine, candidates, { apply: true, agent: 'distill:web:redo' });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  app.post('/api/sessions/:id/distill', ae(async (req, res, held) => {
    const id = String(req.params.id);
    const { apply = false, limit, pick } = req.body ?? {};
    const full = loadSessionFull(id);
    if (full === null) { res.status(404).json({ error: 'session not found' }); return; }

    const rules = loadIgnoreRules();
    if (rules.isIgnored({ id: full.session.id, title: full.session.title, cwd: full.session.cwd, project: full.session.project, agent: full.session.agent })) {
      res.status(403).json({ error: '该会话命中 .hippoignore 排除规则', excluded: true });
      return;
    }
    if (full.turns.length === 0) {
      res.json({ candidates: [], note: '无可解析内容', created: 0, reinforced: 0, skipped: 0, maybe: 0 });
      return;
    }
    // 会话级项目覆盖（索引已给真实 cwd 推导的项目名）：assistant 轮无 cwd，
    // 逐轮取会把候选漏进 global——与自动蒸馏同一修法
    let candidates = extractCandidates(full.turns, { projectOverride: full.session.project })
      .slice(0, Math.min(Number(limit) || MAX_CANDIDATES, MAX_CANDIDATES));
    // pick：候选下标数组（蒸馏页按条勾选入库）；预览时忽略。
    if (Array.isArray(pick)) {
      const keep = new Set(pick.map((i: unknown) => Number(i)));
      candidates = candidates.filter((_, i) => keep.has(i));
    }
    try {
      const result = await runDistill(held.engine, candidates, {
        apply: Boolean(apply),
        agent: `distill:${full.session.agent}`,
        turns: full.turns,
      });
      if (apply) {
        const sourceId = candidates.find((c) => c.source_id !== '')?.source_id ?? '';
        recordSessionDistill({
          id: full.session.id, sourceId,
          created: result.created, reinforced: result.reinforced,
          skipped: result.skipped, maybe: result.maybe,
        });
      }
      res.json({
        apply: Boolean(apply),
        scannedTurns: full.turns.length,
        candidates: candidates.map((c) => ({ text: c.text, type: c.type, confidence: c.confidence, duplicate: c.duplicate })),
        created: result.created, reinforced: result.reinforced, skipped: result.skipped, maybe: result.maybe,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  // 会话 → 蒸馏出的记忆列表（G2 双向跳转）：按 session_distills 的 source_id
  // 关联记忆库（同一次蒸馏的候选共享一个 L0 source）。
  app.get('/api/sessions/:id/memories', ae(async (req, res, held) => {
    const id = String(req.params.id);
    const distills = listSessionDistills(id);
    const sourceIds = new Set(distills.map((d) => d.sourceId).filter((s) => s !== ''));
    if (sourceIds.size === 0) { res.json({ memories: [], count: 0 }); return; }
    const records = ((held.engine.store as any).scan() as [MemoryRecord, number][])
      .map(([r]) => r as MemoryRecord)
      .filter((r) => r.source_id !== undefined && r.source_id !== '' && sourceIds.has(r.source_id))
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    res.json({ count: records.length, memories: records });
  }));

  // G4 恢复会话：拼 CLI 命令并拉起终端（不代理会话本体）；未验证 CLI 的 agent 返回 unsupported
  app.post('/api/sessions/:id/resume', (req, res) => {
    const full = loadSessionFull(String(req.params.id));
    if (full === null) { res.status(404).json({ error: 'session not found' }); return; }
    // 真实 cwd 优先取 Turn 流（claude 的 SessionRef.cwd 是 mangled 目录名，仅展示用）；
    // 索引 turns 未存 cwd，兜底现场解析。取最后一个非空 cwd（会话中途可能 cd 过，
    // 最初的工作目录≠最终的项目目录——用户恢复时要回到"最后在的地方"）。
    const BS = String.fromCharCode(92)
    const lastCwd = (turns: Array<{ cwd?: string }>): string => {
      for (let i = turns.length - 1; i >= 0; i--) {
        const c = turns[i]?.cwd ?? ''
        if (c.includes(BS) || c.includes('/')) return c
      }
      return ''
    }
    let turnCwd = lastCwd(full.turns)
    if (turnCwd === '') {
      turnCwd = lastCwd(parseSession(full.session.agent, full.session.id))
    }
    const plan = resumePlanFor(full.session.agent, full.session.id, turnCwd || full.session.cwd);
    if (plan === null) {
      res.status(501).json({ error: `「${full.session.agent}」暂无已验证的恢复命令`, unsupported: true });
      return;
    }
    const r = launchTerminal(plan);
    if (!r.ok) { res.status(500).json({ error: r.error }); return; }
    res.json({ ok: true, command: plan.command, cwd: plan.cwd, via: r.via });
  });

  // 详情：完整 Turn 流 + 历史蒸馏记录（"已蒸馏 N 条"）
  app.get('/api/sessions/:id', (req, res) => {
    const full = loadSessionFull(String(req.params.id));
    if (full === null) { res.status(404).json({ error: 'session not found' }); return; }
    const distills = listSessionDistills(full.session.id);
    res.json({
      session: full.session,
      fromIndex: !full.live,
      turns: full.turns,
      distilledCount: distills.reduce((sum, d) => sum + d.created + d.reinforced, 0),
      distills,
    });
  });

  // SPA 回退（生产模式）：非 /api 的 GET html 请求落到构建产物入口
  if (hasStatic) {
    app.use((req, res, next) => {
      if (req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/api/')) {
        res.sendFile(spaIndex);
        return;
      }
      next();
    });
  }

  // 自动蒸馏定时器：独立进程（hippo gui）自己管；桥接模式（dsh 插件）
  // 由插件侧 startAutoDistillTimer 统一管，避免双定时器。
  if (opts.autoTimer !== false) {
    const stopAuto = startAutoDistillTimer();
    void stopAuto;
  }

  return app;
}

export function startHttpServer(port: number = DEFAULT_PORT, opts: HttpServerOptions = {}): HttpServer {
  const app = buildHttpApp({ ...opts, autoTimer: false });
  const stopAuto = startAutoDistillTimer();

  const server = app.listen(port) as unknown as Server;
  const actualPort = (() => {
    const addr = server.address();
    return addr && typeof addr === 'object' ? addr.port : port;
  })();

  const httpServer: HttpServer = {
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    close: () => {
      stopAuto();
      server.close();
      ;(app as unknown as { __hippoStopSessionSync?: () => void }).__hippoStopSessionSync?.();
    },
  };
  return httpServer;
}

export { VALID_TYPES };
