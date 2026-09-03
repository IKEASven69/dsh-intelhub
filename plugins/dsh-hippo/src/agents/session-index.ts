/**
 * 会话索引层：把四家适配器的发现/解析结果落成可检索的本地库
 * <dataDir>/sessions.db（better-sqlite3 + FTS5 trigram，支持中文子串）。
 *
 * 为什么要有索引：搜索要对全部会话正文匹配；实时逐个解析（仅 zcode 全量就
 * ~20s）不可接受。索引按 G0 的指纹层做增量——指纹未变的会话直接跳过，
 * 二次同步毫秒级。GUI 列表走实时 discover（轻量），详情/搜索走本索引。
 *
 * 蒸馏排除（.hippoignore）不在这里生效：隐私排除约束的是"提取记忆"，
 * 不约束浏览——GUI 要能看到全部会话才能决定蒸馏哪些。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { dataDir } from '../hippo/store.js'
import { cwdToProject } from '../patterns/transcript.js'
import type { Turn } from '../patterns/transcript.js'
import { AGENTS, inventory } from './index.js'
import { loadIgnoreRules } from './ignore.js'
import type { SessionAdapter, SessionRef } from './types.js'

interface RoDatabase {
  prepare: (sql: string) => {
    all: (...args: unknown[]) => unknown[]
    run: (...args: unknown[]) => unknown
    get: (...args: unknown[]) => unknown
  }
  exec: (sql: string) => void
  pragma: (s: string) => unknown
  transaction: (fn: () => void) => () => void
  close: () => void
}

function requireDatabase() {
  const req = createRequire(import.meta.url)
  return req('better-sqlite3') as new (path: string, opts?: object) => RoDatabase
}

/** 打开（并按需建表）sessions.db；dir 可注入供单测。 */
export function openSessionIndex(dataDirOverride?: string): RoDatabase & { close(): void } {
  const dir = dataDirOverride ?? dataDir()
  mkdirSync(dir, { recursive: true })
  const Database = requireDatabase()
  const db = new Database(join(dir, 'sessions.db'))
  // 先取原生 close（Object.assign 覆盖后自引用会无限递归）
  const nativeClose = db.close.bind(db) as () => void
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      ext_id      TEXT PRIMARY KEY,
      agent       TEXT NOT NULL,
      title       TEXT NOT NULL,
      cwd         TEXT NOT NULL DEFAULT '',
      project     TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT NOT NULL DEFAULT '',
      turn_count  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE TABLE IF NOT EXISTS turns (
      session_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      role        TEXT NOT NULL,
      ts          TEXT NOT NULL DEFAULT '',
      text        TEXT NOT NULL DEFAULT '',
      tool_name   TEXT NOT NULL DEFAULT '',
      tool_failed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, seq)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
      text, content='turns', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TABLE IF NOT EXISTS session_distills (
      ext_id     TEXT NOT NULL,
      source_id  TEXT NOT NULL,
      at         INTEGER NOT NULL,
      created    INTEGER NOT NULL DEFAULT 0,
      reinforced INTEGER NOT NULL DEFAULT 0,
      skipped    INTEGER NOT NULL DEFAULT 0,
      maybe      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ext_id, source_id, at)
    );
  `)
  return Object.assign(db, { close: () => nativeClose() })
}

export interface SyncResult {
  /** 本次发现的会话总数 */
  total: number
  added: number
  updated: number
  /** 源已消失、从索引移除的会话数 */
  removed: number
  /** 指纹未变直接跳过的会话数 */
  unchanged: number
}

/**
 * 增量同步：重新发现全部会话，与库内指纹比对——新增/变化的重解析入库，
 * 消失的连 turns 一起删掉，未变的跳过。adapters 可注入供单测。
 */
export function syncSessionIndex(opts: { dataDir?: string; adapters?: SessionAdapter[] } = {}): SyncResult {
  const adapters = opts.adapters ?? AGENTS.filter((a) => a.supported)
  const discovered: SessionRef[] = []
  for (const a of adapters) {
    if (!a.supported) continue
    try {
      discovered.push(...a.discover())
    } catch {
      // 单家失败不拖垮整体同步（与 discoverAll 同策略）
    }
  }

  const db = openSessionIndex(opts.dataDir)
  try {
    const byName = new Map(adapters.map((a) => [a.name, a]))
    const existing = new Map<string, string>(
      (db.prepare('SELECT ext_id, fingerprint FROM sessions').all() as { ext_id: string; fingerprint: string }[])
        .map((r) => [r.ext_id, r.fingerprint]),
    )

    const upSession = db.prepare(`
      INSERT INTO sessions (ext_id, agent, title, cwd, project, updated_at, fingerprint, turn_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ext_id) DO UPDATE SET
        agent=excluded.agent, title=excluded.title, cwd=excluded.cwd,
        project=excluded.project, updated_at=excluded.updated_at,
        fingerprint=excluded.fingerprint, turn_count=excluded.turn_count
    `)
    const insertTurn = db.prepare(
      'INSERT INTO turns (session_id, seq, role, ts, text, tool_name, tool_failed) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const deleteTurns = db.prepare('DELETE FROM turns WHERE session_id = ?')

    // .hippoignore 在导入前生效：被删除（已写 ignore）的会话不再回流
    const ignore = loadIgnoreRules()
    const result: SyncResult = { total: discovered.length, added: 0, updated: 0, removed: 0, unchanged: 0 }
    const seen = new Set<string>()

    for (const ref of discovered) {
      if (ignore.isIgnored({ title: ref.title, cwd: ref.cwd, agent: ref.agent, id: ref.id, project: cwdToProject(ref.cwd) })) continue
      seen.add(ref.id)
      if (existing.get(ref.id) === ref.fingerprint) {
        result.unchanged += 1
        continue
      }
      let turns: Turn[] = []
      const adapter = byName.get(ref.agent)
      if (adapter !== undefined) {
        try {
          turns = adapter.parse(ref.id)
        } catch {
          turns = [] // 解析失败记为空但落指纹，避免每次全量重试拖慢同步
        }
      }
      db.transaction(() => {
        upSession.run(
          ref.id, ref.agent, ref.title, ref.cwd,
          cwdToProject(ref.cwd), Math.round(ref.updatedAt), ref.fingerprint, turns.length,
        )
        deleteTurns.run(ref.id)
        turns.forEach((t, i) =>
          insertTurn.run(ref.id, i, t.role, t.ts, t.text, t.toolName, t.toolFailed ? 1 : 0),
        )
      })()
      if (existing.has(ref.id)) result.updated += 1
      else result.added += 1
    }

    // 源里消失的会话：连正文一起清掉
    const goneIds = [...existing.keys()].filter((id) => !seen.has(id))
    const deleteSession = db.prepare('DELETE FROM sessions WHERE ext_id = ?')
    for (const id of goneIds) {
      db.transaction(() => {
        deleteTurns.run(id)
        deleteSession.run(id)
      })()
    }
    result.removed = goneIds.length
    return result
  } finally {
    db.close()
  }
}

/** 索引里的会话行（列表用）。 */
export interface IndexedSession {
  id: string
  agent: string
  title: string
  cwd: string
  project: string
  updatedAt: number
  turnCount: number
}

const SESSION_COLS = 'ext_id, agent, title, cwd, project, updated_at, turn_count'

function toIndexed(r: Record<string, unknown>): IndexedSession {
  return {
    id: r.ext_id as string,
    agent: r.agent as string,
    title: r.title as string,
    cwd: r.cwd as string,
    project: r.project as string,
    updatedAt: Number(r.updated_at ?? 0),
    turnCount: Number(r.turn_count ?? 0),
  }
}

/** 分页列表（按更新时间倒序）。agent/project 可过滤。 */
export function listSessions(opts: { dataDir?: string; agent?: string; project?: string; limit?: number; offset?: number } = {}): IndexedSession[] {
  const db = openSessionIndex(opts.dataDir)
  try {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.agent) { where.push('agent = ?'); args.push(opts.agent) }
    if (opts.project) { where.push('project = ?'); args.push(opts.project) }
    const sql = `SELECT ${SESSION_COLS} FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    args.push(Math.min(Math.max(opts.limit ?? 50, 1), 500), Math.max(opts.offset ?? 0, 0))
    return (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(toIndexed)
  } finally {
    db.close()
  }
}

/** ext_id → turn_count 映射（列表富化用：GUI 显示"已解析 N 轮/待索引"）。 */
export function turnCountMap(opts: { dataDir?: string } = {}): Map<string, number> {
  const db = openSessionIndex(opts.dataDir)
  try {
    const rows = db.prepare('SELECT ext_id, turn_count FROM sessions').all() as { ext_id: string; turn_count: number }[]
    return new Map(rows.map((r) => [r.ext_id, Number(r.turn_count)]))
  } finally {
    db.close()
  }
}

/** 详情：完整 Turn 流（seq 升序）。找不到返回 null。 */
export function getIndexedSession(id: string, opts: { dataDir?: string } = {}): { session: IndexedSession; turns: Turn[] } | null {
  const db = openSessionIndex(opts.dataDir)
  try {
    const row = db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE ext_id = ?`).get(id) as Record<string, unknown> | undefined
    if (row === undefined) return null
    const turns = (db.prepare(
      'SELECT role, ts, text, tool_name, tool_failed FROM turns WHERE session_id = ? ORDER BY seq',
    ).all(id) as Record<string, unknown>[]).map((t) => ({
      role: t.role as Turn['role'],
      text: String(t.text ?? ''),
      cwd: '',
      ts: String(t.ts ?? ''),
      toolName: String(t.tool_name ?? ''),
      toolFailed: Boolean(t.tool_failed),
      model: '',
    }))
    return { session: toIndexed(row), turns }
  } finally {
    db.close()
  }
}

/** 搜索命中（单会话聚合）。 */
export interface SessionSearchHit extends IndexedSession {
  matchCount: number
  /** 首个命中的上下文片段（前后各留 ~40 字符）。 */
  snippet: string
}

const SNIPPET_RADIUS = 40

function makeSnippet(text: string, q: string): string {
  const at = text.indexOf(q)
  if (at < 0) return text.slice(0, SNIPPET_RADIUS * 2)
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(text.length, at + q.length + SNIPPET_RADIUS)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/**
 * 全文搜索（含中文）：≥3 字符走 FTS5 trigram 索引，更短的子串回退 LIKE 扫描；
 * 标题命中也计入。按命中次数倒序返回会话级聚合。
 */
export function searchSessions(q: string, opts: { dataDir?: string; agent?: string; limit?: number } = {}): SessionSearchHit[] {
  const needle = q.trim()
  if (needle === '') return []
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200)
  const db = openSessionIndex(opts.dataDir)
  try {
    const agentFilterSql = opts.agent ? 'AND s.agent = ?' : ''
    const agentArg = opts.agent ? [opts.agent] : []

    // 正文命中：trigram MATCH（查询词包双引号防语法注入），短查询回退 LIKE。
    // snippet() 是 FTS5 辅助函数、不能进聚合——计数在 SQL 聚合，
    // 片段等排序截断后只对返回的头部命中逐个补查。
    let bodyHits: { session_id: string; hits: number }[] = []
    if (needle.length >= 3) {
      // 多词查询拆 OR 词项（短语匹配对"知识库 搜索"这类查询必然落空）
      const terms = needle.split(/\s+/).filter((t) => t.length >= 2)
      const matchExpr = terms.length > 1
        ? terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
        : `"${needle.replace(/"/g, '""')}"`
      bodyHits = db.prepare(`
        SELECT t.session_id AS session_id, COUNT(*) AS hits
        FROM turns_fts f
        JOIN turns t ON t.rowid = f.rowid
        WHERE turns_fts MATCH ?
        GROUP BY t.session_id
      `).all(matchExpr) as typeof bodyHits
    } else {
      const esc = needle.replace(/[\\%_]/g, (c) => '\\' + c)
      bodyHits = db.prepare(`
        SELECT t.session_id AS session_id, COUNT(*) AS hits
        FROM turns t
        WHERE t.text LIKE ? ESCAPE '\\'
        GROUP BY t.session_id
      `).all(`%${esc}%`) as typeof bodyHits
    }

    // 标题命中（LIKE 子串即可，标题量小）
    const titleEsc = needle.replace(/[\\%_]/g, (c) => '\\' + c)
    const titleRows = db.prepare(`
      SELECT ${SESSION_COLS} FROM sessions
      WHERE title LIKE ? ESCAPE '\\' ${opts.agent ? 'AND agent = ?' : ''}
    `).all(...(opts.agent ? [`%${titleEsc}%`, opts.agent] : [`%${titleEsc}%`])) as Record<string, unknown>[]

    const merged = new Map<string, SessionSearchHit>()
    const ids = new Set([...bodyHits.map((h) => h.session_id), ...titleRows.map((r) => r.ext_id as string)])
    if (ids.size === 0) return []
    // 一条 SQL 取齐会话元数据，避免逐 id 查询
    const placeholders = [...ids].map(() => '?').join(',')
    const metaRows = db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE ext_id IN (${placeholders}) ${agentFilterSql}`)
      .all(...[...ids], ...agentArg) as Record<string, unknown>[]
    for (const r of metaRows) {
      const base = toIndexed(r)
      merged.set(base.id, { ...base, matchCount: 0, snippet: '' })
    }
    // 片段补查：只对最终要返回的命中做（先按计数排序截断）
    const sampleStmt = db.prepare(
      'SELECT text FROM turns WHERE session_id = ? AND instr(text, ?) > 0 ORDER BY seq LIMIT 1',
    )
    for (const h of bodyHits) {
      const hit = merged.get(h.session_id)
      if (!hit) continue
      hit.matchCount += Number(h.hits)
    }
    for (const r of titleRows) {
      const hit = merged.get(r.ext_id as string)
      if (!hit) continue
      hit.matchCount += 1
    }
    const ranked = [...merged.values()]
      .filter((h) => h.matchCount > 0)
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, limit)
    for (const hit of ranked) {
      const row = sampleStmt.get(hit.id, needle) as { text?: string } | undefined
      hit.snippet = row?.text !== undefined ? makeSnippet(row.text, needle) : makeSnippet(hit.title, needle)
    }
    return ranked
  } finally {
    db.close()
  }
}

/** 索引状态概览（doctor/面板用）：各 agent 已索引会话数与总 turn 数。 */
export function indexStats(opts: { dataDir?: string } = {}): { agents: { agent: string; indexed: number }[]; turns: number } {
  const db = openSessionIndex(opts.dataDir)
  try {
    const agents = (db.prepare('SELECT agent, COUNT(*) AS n FROM sessions GROUP BY agent ORDER BY agent').all() as { agent: string; n: number }[])
      .map((r) => ({ agent: r.agent, indexed: Number(r.n) }))
    const turnsRow = db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }
    return { agents, turns: Number(turnsRow.n) }
  } finally {
    db.close()
  }
}

// ── 会话 ↔ 蒸馏记录：详情页"已蒸馏 N 条"与 G2 记忆→会话跳转的数据面 ──

export interface SessionDistillRecord {
  sourceId: string
  at: number
  created: number
  reinforced: number
  skipped: number
  maybe: number
}

/** 记一次对某会话的蒸馏（apply 成功后调用）。 */
export function recordSessionDistill(
  entry: { id: string; sourceId: string; created?: number; reinforced?: number; skipped?: number; maybe?: number },
  opts: { dataDir?: string } = {},
): void {
  const db = openSessionIndex(opts.dataDir)
  try {
    db.prepare('INSERT INTO session_distills (ext_id, source_id, at, created, reinforced, skipped, maybe) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(entry.id, entry.sourceId, Date.now(), entry.created ?? 0, entry.reinforced ?? 0, entry.skipped ?? 0, entry.maybe ?? 0)
  } finally {
    db.close()
  }
}

/** 某会话的全部蒸馏记录（时间倒序）。 */
export function listSessionDistills(id: string, opts: { dataDir?: string } = {}): SessionDistillRecord[] {
  const db = openSessionIndex(opts.dataDir)
  try {
    return (db.prepare(
      'SELECT source_id, at, created, reinforced, skipped, maybe FROM session_distills WHERE ext_id = ? ORDER BY at DESC',
    ).all(id) as Record<string, unknown>[]).map((r) => ({
      sourceId: String(r.source_id),
      at: Number(r.at),
      created: Number(r.created ?? 0),
      reinforced: Number(r.reinforced ?? 0),
      skipped: Number(r.skipped ?? 0),
      maybe: Number(r.maybe ?? 0),
    }))
  } finally {
    db.close()
  }
}

/** ext_id → 已蒸馏条数（created+reinforced 合计），列表行"是否已蒸馏"标记用。 */
export function distilledCountMap(opts: { dataDir?: string } = {}): Map<string, number> {
  const db = openSessionIndex(opts.dataDir)
  try {
    const rows = db.prepare(
      'SELECT ext_id, SUM(created + reinforced) AS n FROM session_distills GROUP BY ext_id',
    ).all() as { ext_id: string; n: number | null }[]
    return new Map(rows.map((r) => [r.ext_id, Number(r.n ?? 0)]))
  } finally {
    db.close()
  }
}

/** 删除一个会话的索引行（sessions + turns；不碰 session_distills 历史）。 */
export function removeSessionRows(extId: string, opts: { dataDir?: string } = {}): boolean {
  const db = openSessionIndex(opts.dataDir)
  try {
    const r1 = db.prepare('DELETE FROM turns WHERE session_id = ?').run(extId) as unknown as { changes: number }
    const r2 = db.prepare('DELETE FROM sessions WHERE ext_id = ?').run(extId) as unknown as { changes: number }
    return r2.changes > 0 || r1.changes > 0
  } finally {
    db.close()
  }
}

/** 记忆 → 会话：按 L0 source_id 反查所属会话（记忆卡跳转用）。 */
export function findSessionBySource(sourceId: string, opts: { dataDir?: string } = {}): string | null {
  if (!sourceId) return null
  const db = openSessionIndex(opts.dataDir)
  try {
    const row = db.prepare('SELECT ext_id FROM session_distills WHERE source_id = ? ORDER BY at DESC LIMIT 1').get(sourceId) as { ext_id?: string } | undefined
    return row?.ext_id ?? null
  } finally {
    db.close()
  }
}

void inventory // 保留引用：未来 inventory 面板接索引状态时复用

// ── 会话语义检索（H11 M-A）：FTS 关键字 + 向量语义 → RRF 融合 ──────────
// 会话向量惰性生成：搜索时对无向量会话嵌入 title+首轮用户消息（≤1000 会话
// 直接 JS 余弦，无需向量索引）。向量缓存于 sessions.vec 列（老库自动迁移）。

let embedFn: ((text: string) => Promise<Float32Array>) | null = null
/** 注入嵌入函数（engine-holder 启动时接 bge-m3；未注入=纯关键字搜索）。 */
export function setSessionEmbedder(fn: (text: string) => Promise<Float32Array>): void {
  embedFn = fn
}

/** 确保老库有 vec 列（ALTER TABLE 幂等）。 */
function ensureVecColumn(db: RoDatabase): void {
  try { db.prepare('SELECT vec FROM sessions LIMIT 1').get() } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN vec BLOB')
  }
}

/** 会话摘要文本：标题 + 首轮用户消息（截 400 字符）。 */
export function sessionSummaryText(title: string, firstUserText: string): string {
  return `${title}\n${firstUserText.slice(0, 400)}`.trim()
}

function cosSim(a: Float32Array | null, b: Float32Array): number {
  if (a === null || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < b.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function bytesToVec(buf: Buffer | Uint8Array | null | undefined): Float32Array | null {
  if (!buf) return null
  try { return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) } catch { return null }
}

/**
 * 语义+混合会话搜索：关键字（searchSessions 的 FTS/LIKE）与向量语义（RRF 融合）。
 * embedFn 未注入或无会话向量时退化为纯关键字。
 */
export async function searchSessionsHybrid(
  q: string,
  opts: { dataDir?: string; agent?: string; limit?: number } = {},
): Promise<SessionSearchHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200)
  const kw = searchSessions(q, opts)
  if (embedFn === null || q.trim() === '') return kw
  const db = openSessionIndex(opts.dataDir)
  try {
    ensureVecColumn(db)
    const qvec = await embedFn(q)
    const agentFilterSql = opts.agent ? 'AND agent = ?' : ''
    const agentArg = opts.agent ? [opts.agent] : []
    // 惰性补向量：无向量的会话现场嵌入（首个用户轮 + 标题），写回缓存
    const missing = db.prepare(
      `SELECT ext_id, title FROM sessions WHERE vec IS NULL ${agentFilterSql} LIMIT 60`,
    ).all(...agentArg) as { ext_id: string; title: string }[]
    if (missing.length > 0) {
      const upd = db.prepare('UPDATE sessions SET vec = ? WHERE ext_id = ?')
      for (const m of missing) {
        const first = db.prepare(
          "SELECT text FROM turns WHERE session_id = ? AND role = 'user' AND text != '' ORDER BY seq LIMIT 1",
        ).get(m.ext_id) as { text?: string } | undefined
        try {
          const vec = await embedFn(sessionSummaryText(m.title, first?.text ?? ''))
          upd.run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), m.ext_id)
        } catch { upd.run(null, m.ext_id) } // 嵌入失败不缓存，下次重试
      }
    }
    // 全量余弦（库 ≤1000 会话量级，JS 足够）
    const rows = db.prepare(
      `SELECT ext_id, vec FROM sessions WHERE vec IS NOT NULL ${agentFilterSql}`,
    ).all(...agentArg) as { ext_id: string; vec: Buffer }[]
    const sem = rows
      .map((r) => ({ id: r.ext_id, sim: cosSim(bytesToVec(r.vec), qvec) }))
      .filter((x) => x.sim > 0.35)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit)
    // RRF 融合：关键字榜 + 语义榜
    const metaStmt = db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE ext_id = ?`)
    const merged = new Map<string, SessionSearchHit>()
    const add = (id: string, score: number, semantic: boolean): void => {
      const hit = merged.get(id)
      if (hit === undefined) {
        const row = metaStmt.get(id) as Record<string, unknown> | undefined
        if (row === undefined) return
        merged.set(id, { ...toIndexed(row), matchCount: 0, snippet: '' })
      }
      const cur = merged.get(id)!
      cur.matchCount += score
      if (semantic && cur.snippet === '') cur.snippet = '语义命中'
    }
    kw.forEach((h, i) => add(h.id, 1 / (60 + i + 1), false))
    sem.forEach((s, i) => add(s.id, 1 / (60 + i + 1), true))
    const ranked = [...merged.values()]
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, limit)
    // 语义-only 命中补 snippet
    for (const h of ranked) {
      if (h.snippet === '') h.snippet = makeSnippet(h.title, q)
    }
    return ranked
  } finally {
    db.close()
  }
}
