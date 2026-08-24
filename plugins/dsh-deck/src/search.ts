/**
 * 知识库全文索引：better-sqlite3 + FTS5（tokenize=trigram，中文子串可查）。
 * mtime 增量：全扫 5487 md 实测 2.4s（仅首建/变更时），查询目标 <100ms。
 * 文件枚举注入可测（FsWalk 接口）。
 * @module dsh-deck/search
 */
import Database from 'better-sqlite3'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface SearchHit {
  path: string
  title: string
  snippet: string
}

export interface FsWalk {
  /** 相对根的 md 文件清单：[relPath, mtimeMs]；跳过 .git/node_modules 等。 */
  list(): Array<[string, number]>
  read(rel: string): string | null
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'panel-src', '.obsidian', '.trash'])

export function walkDir(root: string): Array<[string, number]> {
  const out: Array<[string, number]> = []
  const stack = ['']
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const rel = dir === '' ? e.name : dir + '/' + e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(rel)
      } else if (e.isFile() && e.name.endsWith('.md')) {
        try { out.push([rel, statSync(join(root, rel)).mtimeMs]) } catch { /* 竞态跳过 */ }
      }
    }
  }
  return out
}

export class KbIndex {
  private db: Database.Database

  constructor(dbPath: string, private readonly root: string, private readonly walk: FsWalk) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
      path UNINDEXED, title, body, mtime UNINDEXED, tokenize='trigram')`)
  }

  /** mtime 增量同步：新/改入索引，消失的删除。返回 {added, updated, removed}。 */
  sync(): { added: number; updated: number; removed: number } {
    const files = this.walk.list()
    const current = new Map(files)
    const existing = new Map<string, number>()
    for (const row of this.db.prepare('SELECT path, mtime FROM docs').all() as Array<{ path: string; mtime: number }>) {
      existing.set(row.path, row.mtime)
    }
    let added = 0, updated = 0, removed = 0
    const insert = this.db.prepare('INSERT INTO docs(path, title, body, mtime) VALUES (?, ?, ?, ?)')
    const del = this.db.prepare('DELETE FROM docs WHERE path = ?')
    const tx = this.db.transaction(() => {
      for (const [rel] of existing) {
        if (!current.has(rel)) { del.run(rel); removed++ }
      }
      for (const [rel, mtime] of current) {
        const prev = existing.get(rel)
        if (prev === mtime) continue
        const text = this.walk.read(rel)
        if (text === null) continue
        if (prev !== undefined) { del.run(rel); updated++ } else { added++ }
        insert.run(rel, titleOf(rel, text), text.slice(0, 512 * 1024), mtime)
      }
    })
    tx()
    return { added, updated, removed }
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) AS c FROM docs').get() as { c: number }).c
  }

  /**
   * 查询：≥3 字符走 trigram MATCH（中文子串可查），更短回退 LIKE 全扫。
   * 返回片段用 «» 高亮命中。
   */
  query(q: string, limit = 20): SearchHit[] {
    const needle = q.trim()
    if (needle === '') return []
    if (needle.length >= 3) {
      const phrase = '"' + needle.replaceAll('"', '""') + '"'
      const rows = this.db.prepare(
        `SELECT path, title, snippet(docs, 2, '«', '»', '…', 16) AS snip
         FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?`,
      ).all(phrase, limit) as Array<{ path: string; title: string; snip: string }>
      return rows.map((r) => ({ path: r.path, title: r.title, snippet: r.snip }))
    }
    const rows = this.db.prepare(
      `SELECT path, title, substr(body, max(1, instr(body, ?) - 40), 90) AS snip
       FROM docs WHERE body LIKE ? LIMIT ?`,
    ).all(needle, '%' + needle.replaceAll('%', '\\%') + '%', limit) as Array<{ path: string; title: string; snip: string }>
    return rows.map((r) => ({ path: r.path, title: r.title, snippet: r.snip ?? '' }))
  }

  close(): void {
    this.db.close()
  }
}

function titleOf(rel: string, text: string): string {
  const h = text.match(/^#\s+(.+)$/m)
  if (h !== null) return h[1]!.trim().slice(0, 120)
  return rel.split('/').pop()!.replace(/\.md$/, '')
}

/** 生产用 walk：node fs 直读（readFileSync 仅在 sync 增量命中时发生）。 */
export function nodeWalk(root: string): FsWalk {
  return {
    list: () => walkDir(root),
    read: (rel) => { try { return readFileSync(join(root, rel), 'utf8') } catch { return null } },
  }
}
