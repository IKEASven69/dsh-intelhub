/**
 * D2 回归：frontmatter 解析/更新、FTS5 trigram 中文子串检索与 mtime 增量、
 * 点子捕获→采纳（调研卡/选题夹）全链路。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDoc, serializeDoc, updateFrontmatter } from '../src/frontmatter.ts'
import { KbIndex, type FsWalk } from '../src/search.ts'
import { adoptIdea, captureIdea, listIdeas, slugify, type IdeasFs } from '../src/ideas.ts'

describe('frontmatter', () => {
  it('解析平铺字段与 body；容忍引号/无头', () => {
    const d = parseDoc('---\nstatus: seed\ncreated: "2026-08-24"\ntitle: 中文 标题\n---\n\n正文\n')
    expect(d.data.status).toBe('seed')
    expect(d.data.created).toBe('2026-08-24')
    expect(d.body.trim()).toBe('正文')
    expect(parseDoc('无头文档').data).toEqual({})
  })
  it('updateFrontmatter 保序更新 + 新键追加', () => {
    const t = updateFrontmatter('---\na: 1\nb: 2\n---\nbody', { b: '改', c: '新' })
    expect(t).toContain('a: 1')
    expect(t).toContain('b: 改')
    expect(t).toContain('c: 新')
    expect(t).toContain('body')
  })
})

const dir = mkdtempSync(join(tmpdir(), `dsh-deck-d2-${Date.now().toString(36)}-`))
const dbId = Date.now().toString(36)
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 残留不阻断 */ } })

interface MemWalk extends FsWalk { touch(rel: string): void }

function memWalk(files: Map<string, string>): MemWalk {
  const mtimes = new Map<string, number>()
  let tick = 0
  const mtimeOf = (rel: string): number => {
    let m = mtimes.get(rel)
    if (m === undefined) { m = ++tick; mtimes.set(rel, m) }
    return m
  }
  return {
    list: () => [...files.keys()].map((p) => [p, mtimeOf(p)] as [string, number]),
    read: (rel) => files.get(rel) ?? null,
    touch: (rel) => { mtimes.set(rel, ++tick) },
  }
}

describe('KbIndex（FTS5 trigram）', () => {
  it('中文子串命中 + 标题提取 + 增量（改文件→更新；删文件→移除）', () => {
    const files = new Map<string, string>([
      ['a/x.md', '# 第一篇\n\n预测市场的基本判断是流动性决定价格发现。'],
      ['b/y.md', '# Second\n\nprediction market liquidity matters'],
    ])
    const db = join(dir, `t1-${dbId}.db`)
    const walk = memWalk(files)
    const idx = new KbIndex(db, dir, walk)
    const s1 = idx.sync()
    expect(s1.added).toBe(2)
    expect(idx.count()).toBe(2)

    const zh = idx.query('流动性决定')
    expect(zh.length).toBe(1)
    expect(zh[0]!.path).toBe('a/x.md')
    expect(zh[0]!.title).toBe('第一篇')
    expect(zh[0]!.snippet).toContain('«流动性决定»')

    const en = idx.query('liquidity')
    expect(en.length).toBe(1)
    expect(en[0]!.path).toBe('b/y.md')

    files.set('a/x.md', '# 第一篇改\n\n内容变了：协处理器架构')
    files.delete('b/y.md')
    walk.touch('a/x.md')
    const s2 = idx.sync()
    expect(s2.updated).toBe(1)
    expect(s2.removed).toBe(1)
    expect(idx.query('liquidity').length).toBe(0)
    expect(idx.query('协处理器').length).toBe(1)
    idx.close()
  })
  it('短词（<3字符）走 LIKE 回退', () => {
    const files = new Map<string, string>([['c.md', '# t\n\nabc def']])
    const idx = new KbIndex(join(dir, `t2-${dbId}.db`), dir, memWalk(files))
    idx.sync()
    expect(idx.query('ab').length).toBe(1)
    idx.close()
  })
})

function memIdeasFs(): { fs: IdeasFs; store: Map<string, string> } {
  const store = new Map<string, string>()
  const norm = (p: string) => p.replace(/\\/g, '/')
  return {
    store,
    fs: {
      list: (d) => [...store.keys()]
        .filter((k) => norm(k).startsWith(norm(d) + '/'))
        .map((k) => norm(k).slice(norm(d).length + 1)),
      read: (p) => store.get(p) ?? null,
      write: (p, c) => { store.set(p, c) },
      exists: (p) => store.has(p),
      mkdirs: () => {},
    },
  }
}

describe('点子库流转', () => {
  it('捕获→列表→采纳为调研卡→状态 picked；采纳为选题建夹', () => {
    const { fs, store } = memIdeasFs()
    const ideasDir = join(dir, 'ideas')
    const kb = join(dir, 'kb')
    const content = join(dir, 'content')
    const file = captureIdea(fs, ideasDir, '# 做一个竞品监控工具\n\n每天抓取对手更新并对比', new Date('2026-08-24T10:00:00'))
    expect(file).toMatch(/^20260824-100000-/)
    const list = listIdeas(fs, ideasDir)
    expect(list.length).toBe(1)
    expect(list[0]!.status).toBe('seed')
    expect(list[0]!.title).toBe('做一个竞品监控工具')

    const r1 = adoptIdea(fs, ideasDir, file, 'research', kb, content)
    expect(r1.created).toContain('TASK.md')
    const task = store.get(join(kb, 'TASK.md'))!
    expect(task).toContain('status: queued')
    expect(task).toContain('竞品监控')
    expect(store.get(join(ideasDir, file))!).toContain('status: picked')

    const file2 = captureIdea(fs, ideasDir, '# 写一篇 dsh 插件开发教程\n\n面向新手的入门', new Date('2026-08-24T11:00:00'))
    const r2 = adoptIdea(fs, ideasDir, file2, 'content', kb, content)
    expect(r2.created).toContain(slugify('写一篇 dsh 插件开发教程'))
    expect(store.get(join(r2.created, 'meta.md'))!).toContain('status: idea')
  })
})

describe('slugify', () => {
  it('中文保留、非法字符转连字符、空回退 idea', () => {
    expect(slugify('做一个 AI 工具!')).toBe('做一个-AI-工具')
    expect(slugify('///')).toBe('idea')
  })
})
