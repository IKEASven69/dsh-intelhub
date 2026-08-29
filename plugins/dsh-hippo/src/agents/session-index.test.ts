/**
 * session-index 单测：用临时目录的假适配器（两个 .jsonl 会话）驱动
 * 同步→列表→详情→搜索→增量→删除 全生命周期，不碰真实 home 数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { makeTurn, type Turn } from '../patterns/transcript.js'
import type { SessionAdapter, SessionRef } from './types.js'
import {
  syncSessionIndex, listSessions, getIndexedSession,
  searchSessions, indexStats,
} from './session-index.js'

/** 假适配器：dir 下递归的每个 *.jsonl 是一个会话，每行 {"role","text"}。 */
function makeFakeAdapter(name: string, dir: string): SessionAdapter {
  function* walk(d: string): Generator<string> {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) yield* walk(p)
      else if (e.name.endsWith('.jsonl')) yield p
    }
  }
  return {
    name,
    root: dir,
    supported: true,
    discover(): SessionRef[] {
      try {
        return [...walk(dir)].map((p) => {
          const st = statSync(p)
          return {
            agent: name, id: p, title: p.slice(dir.length + 1).replace(/\.jsonl$/, '').replace(/[\\/]/g, '-'), cwd: p.replace(/[\\/][^\\/]+$/, ''),
            updatedAt: st.mtimeMs, fingerprint: `${Math.round(st.mtimeMs)}:${st.size}`,
            kind: 'file' as const,
          }
        })
      } catch {
        return []
      }
    },
    parse(id: string): Turn[] {
      const lines = readFileSync(id, 'utf8').split('\n').filter((l) => l.trim() !== '')
      return lines.map((l) => {
        const o = JSON.parse(l) as { role: Turn['role']; text: string }
        return makeTurn({ role: o.role, text: o.text, cwd: dir })
      })
    },
  }
}

function withTemp<T>(fn: (root: string, dataDir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'hippo-idx-'))
  const store = mkdtempSync(join(tmpdir(), 'hippo-idx-db-'))
  try {
    return fn(root, store)
  } finally {
    // Windows 上 sqlite WAL 句柄释放有延迟：重试仍失败就留给系统临时目录清理
    for (const d of [root, store]) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch { /* 忽略 */ }
    }
  }
}

test('sync_list_get_search_full_lifecycle', () => {
  withTemp((root, dbDir) => {
    const projA = join(root, 'projA')
    const projB = join(root, 'projB')
    mkdirSync(projA)
    mkdirSync(projB)
    writeFileSync(join(projA, 'alpha.jsonl'), [
      JSON.stringify({ role: 'user', text: '帮我优化数据库索引' }),
      JSON.stringify({ role: 'assistant', text: '给 user_id 加复合索引即可' }),
    ].join('\n'))
    writeFileSync(join(projB, 'beta.jsonl'), [
      JSON.stringify({ role: 'user', text: '写个 README 开头' }),
      JSON.stringify({ role: 'assistant', text: '数据库迁移文档如下' }),
    ].join('\n'))

    const adapter = makeFakeAdapter('fake', root)

    // ── 首次全量同步
    let r = syncSessionIndex({ dataDir: dbDir, adapters: [adapter] })
    assert.deepEqual(
      { total: r.total, added: r.added, updated: r.updated, unchanged: r.unchanged },
      { total: 2, added: 2, updated: 0, unchanged: 0 },
    )
    assert.deepEqual(indexStats({ dataDir: dbDir }), { agents: [{ agent: 'fake', indexed: 2 }], turns: 4 })

    // ── 列表：按更新时间倒序 + agent/project 过滤 + 分页
    assert.equal(listSessions({ dataDir: dbDir }).length, 2)
    const onlyA = listSessions({ dataDir: dbDir, project: 'projA' })
    assert.equal(onlyA.length, 1)
    assert.match(onlyA[0]!.title, /alpha/)
    assert.equal(onlyA[0]!.project, 'projA')
    assert.equal(listSessions({ dataDir: dbDir, limit: 1 }).length, 1)

    // ── 详情：完整 Turn 流
    const detail = getIndexedSession(onlyA[0]!.id, { dataDir: dbDir })
    assert.ok(detail !== null)
    assert.equal(detail.turns.length, 2)
    assert.equal(detail.turns[0]!.text, '帮我优化数据库索引')

    // ── 搜索：中文 ≥3 字符走 trigram；标题命中也计入
    const bodyHits = searchSessions('复合索引', { dataDir: dbDir })
    assert.equal(bodyHits.length, 1)
    assert.match(bodyHits[0]!.id, /alpha/)
    assert.ok(bodyHits[0]!.matchCount >= 1)
    assert.ok(bodyHits[0]!.snippet.includes('复合索引'))
    const titleHits = searchSessions('beta', { dataDir: dbDir })
    assert.equal(titleHits.length, 1)
    assert.match(titleHits[0]!.id, /beta/)

    // ── 增量：改一个文件 → updated=1 unchanged=1；指纹未变不重解析
    writeFileSync(join(projA, 'alpha.jsonl'), [
      JSON.stringify({ role: 'user', text: '帮我优化数据库索引' }),
      JSON.stringify({ role: 'assistant', text: '加复合索引，另外补一句缓存策略说明' }),
    ].join('\n'))
    r = syncSessionIndex({ dataDir: dbDir, adapters: [adapter] })
    assert.deepEqual(
      { added: r.added, updated: r.updated, unchanged: r.unchanged },
      { added: 0, updated: 1, unchanged: 1 },
    )
    assert.equal(getIndexedSession(onlyA[0]!.id, { dataDir: dbDir })!.turns.length, 2)
    assert.ok(searchSessions('缓存策略', { dataDir: dbDir }).length === 1)

    // ── 删除：源文件消失 → 索引移除
    rmSync(join(projB, 'beta.jsonl'))
    r = syncSessionIndex({ dataDir: dbDir, adapters: [adapter] })
    assert.equal(r.removed, 1)
    assert.equal(listSessions({ dataDir: dbDir }).length, 1)
    assert.equal(getIndexedSession(join(projB, 'beta.jsonl'), { dataDir: dbDir }), null)

    // ── 短查询（<3 字符）回退 LIKE 不报错
    assert.doesNotThrow(() => searchSessions('索', { dataDir: dbDir }))
  })
})

test('search_quotes_in_query_do_not_break_sql', () => {
  withTemp((_root, dbDir) => {
    const adapter = makeFakeAdapter('fake', mkdtempSync(join(tmpdir(), 'hippo-idx-empty-')))
    try {
      syncSessionIndex({ dataDir: dbDir, adapters: [adapter] })
      // 引号、%_ 通配符都不应抛 SQL 错误
      assert.doesNotThrow(() => searchSessions(`don't "quote" 100%`, { dataDir: dbDir }))
      assert.equal(searchSessions(`don't`, { dataDir: dbDir }).length, 0)
    } finally {
      rmSync(adapter.root, { recursive: true, force: true })
    }
  })
})
