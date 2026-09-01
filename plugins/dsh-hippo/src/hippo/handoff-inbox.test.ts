import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pushHandoff, listInbox, loadHandoff, archivedInbox, detailText, type InboxItem } from './handoff-inbox.js'
import { discoverAll } from '../agents/index.js'
import { groupMemories, renderAgentsMdBody } from './compile.js'

// 隔离收件箱存储（真实 ~/.hippo 不动）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-inbox-'))
process.env.HIPPO_DATA_DIR = TMP

beforeEach(() => {
  fs.writeFileSync(path.join(TMP, 'handoff-inbox.json'), JSON.stringify({ pending: [], archived: [] }))
})

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* Windows 句柄 */ } })

/** 找一个真实存在的会话（集成环境只读依赖 discoverAll）。 */
function anyRealSession(): string {
  const refs = discoverAll()
  assert.ok(refs.length > 0, '本机应有可发现会话')
  return refs[0].id
}

test('push → list → load → 消费即弃 全链路', () => {
  const sid = anyRealSession()
  const item = pushHandoff(sid, { to: 'workbuddy' })
  assert.ok(item.id.startsWith('ho-'))
  assert.ok(item.candidates.length >= 0 && item.activeTasks !== undefined)

  assert.equal(listInbox().length, 1)

  const { text, item: got } = loadHandoff(item.id)
  assert.equal(got.id, item.id)
  assert.ok(text.includes('[handoff'))
  assert.ok(text.includes('原文反查'), '详情带 L0 指针')
  assert.ok(text.includes('执行前须当下确认'), '安全规则随件')
  // 预算：≤500 token ≈ ≤2000 字符（中文 1 token≈1.5-2 字符，保守上限）
  assert.ok(text.length <= 2000, `详情超预算：${text.length}`)

  assert.equal(listInbox().length, 0, '取件后 pending 清空')
  assert.equal(archivedInbox()[0]?.id, item.id, '进归档')
  assert.throws(() => loadHandoff(item.id), /消费即弃/, '二次取件必须报错')
})

test('硬约束：收件箱内容永不进 compile 常驻投影', () => {
  // 造一个带独特标记的 pending 项
  const store = { pending: [{ ...fakeItem(), candidates: ['UNIQUE-INBOX-MARKER-XYZ 不应出现在 AGENTS.md'] }], archived: [] }
  fs.writeFileSync(path.join(TMP, 'handoff-inbox.json'), JSON.stringify(store))
  assert.equal(listInbox().length, 1)

  // compile 投影（全量模式）只吃 记忆 + 任务，不吃收件箱
  const g = groupMemories([])
  const md = renderAgentsMdBody(g)
  assert.ok(!md.includes('UNIQUE-INBOX-MARKER-XYZ'), '收件箱候选不得泄漏进 AGENTS.md')
})

test('detailText：无候选/无 git 的最小快照也能组装', () => {
  const t = detailText(fakeItem())
  assert.ok(t.includes('（无显式卡点）') || t.includes('卡点'))
  assert.ok(t.includes('原文反查'))
})

function fakeItem(): InboxItem {
  return {
    id: 'ho-test', from: { agent: 'zcode', sessionId: 'sess_x', title: '测试会话' },
    to: 'any', project: 'p', cwd: 'D:/p', pushedAt: Date.now() / 1000,
    git: { branch: 'main', changed: ['a.ts'] }, activeTasks: [], candidates: [],
  }
}

void fs; void os; void path
