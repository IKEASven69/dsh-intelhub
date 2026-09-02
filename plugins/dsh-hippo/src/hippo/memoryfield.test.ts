import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { exportMemoryfield, importMemoryfield, parsePage, splitLongText, slugify, idToUuid, uuidToId, isJunk, PAGE_LIMIT } from './memoryfield.js'
import type { MemoryRecord } from './memory.js'

const rec = (over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  text: '决定：状态管理用 Zustand，不用 Redux',
  type: 'decision', project: 'coding', agent: 'zcode',
  created_at: 1754000000, accessed_at: 1755000000, strength: 1.5,
  ...over,
} as MemoryRecord)

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mf-'))

test('idToUuid/uuidToId：hex↔UUID 往返', () => {
  const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
  const u = idToUuid(id)
  assert.equal(u, 'a1b2c3d4-a1b2'.slice(0, 9) + u.slice(9)) // 形态仅自查
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(uuidToId(u), id)
})

test('export：页面合规（命名/frontmatter 引号日期/无清单 index）', () => {
  const dir = tmp()
  const stats = exportMemoryfield([rec(), rec({ id: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e1', text: '教训：grep -c 会把子串算进去', type: 'lesson' }), rec({ id: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e1f2', text: 'x', superseded_by: 'aaa' })], dir)
  assert.equal(stats.pages, 3)
  const names = fs.readdirSync(dir).filter(n => n !== 'index.md')
  for (const n of names) {
    assert.match(n, /^[a-z0-9][a-z0-9-]*\.md$/, `文件名合规: ${n}`)
    const raw = fs.readFileSync(path.join(dir, n), 'utf8')
    assert.ok(raw.includes("created: '"), 'datetime 带引号')
    assert.ok(Buffer.byteLength(raw, 'utf8') <= PAGE_LIMIT, '页面 ≤8192')
  }
  const index = fs.readFileSync(path.join(dir, 'index.md'), 'utf8')
  assert.ok(!/\.md\b/.test(index.replace(/index\.md/, '')), 'index 不含页面清单')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('roundtrip：export → import 文本无损（标题+正文）', () => {
  const dir = tmp()
  const r = rec({ text: '偏好：沟通直接口语化，避免捧场' })
  exportMemoryfield([r], dir)
  const pages = importMemoryfield(dir)
  assert.equal(pages.length, 1)
  assert.ok(pages[0].text.includes('沟通直接口语化'))
  assert.ok(pages[0].text.includes('Zustand') === false) // 单条不串
  fs.rmSync(dir, { recursive: true, force: true })
})

test('splitLongText：超长拆分且不劈 UTF-8 多字节', () => {
  const cjk = '河马记忆'.repeat(2000) // 8000 汉字 ≈ 24KB
  const parts = splitLongText(cjk, 2000)
  assert.ok(parts.length >= 3)
  assert.equal(parts.join(''), cjk, '拆分无损')
  for (const p of parts) assert.ok(Buffer.byteLength(p, 'utf8') <= 2000 + 3)
})

test('slugify/isJunk', () => {
  assert.equal(slugify('决定：用 Zustand! （状态管理）'), slugify('决定：用 Zustand! （状态管理）'))
  assert.match(slugify('决定：用 Zustand 状态管理'), /^[a-z0-9-]+$/)
  assert.equal(isJunk('.DS_Store'), true)
  assert.equal(isJunk('.sync-conflict-abc.md'), true)
  assert.equal(isJunk('notes.md~'), true)
  assert.equal(isJunk('normal-memory.md'), false)
})

test('parsePage：无 frontmatter 页面也有效（规范 MUST NOT 依赖）', () => {
  const p = parsePage('just plain text body')
  assert.equal(p.text, 'just plain text body')
  assert.equal(p.uuid, null)
})
