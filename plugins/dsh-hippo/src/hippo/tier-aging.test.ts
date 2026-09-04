import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupTierCandidates, fallbackDigest, tierAge, isTierCandidate, type TierCompleteFn } from './tier-aging.js'

const NOW = Date.now() / 1000
const OLD = NOW - 120 * 86400 // 120 天前
const RECENT = NOW - 10 * 86400

test('isTierCandidate: 类型/年龄/取代三条件', () => {
  assert.equal(isTierCandidate({ type: 'fact', created_at: OLD }, NOW), true)
  assert.equal(isTierCandidate({ type: 'preference', created_at: OLD }, NOW), false) // preference 豁免
  assert.equal(isTierCandidate({ type: 'fact', created_at: RECENT }, NOW), false) // 太新
  assert.equal(isTierCandidate({ type: 'fact', created_at: OLD, superseded_by: 'x' }, NOW), false) // 已取代
  assert.equal(isTierCandidate({ type: 'fact' }, NOW), false) // 无时间
})

test('groupTierCandidates: 项目+月+类型分组，<3 条不卷', () => {
  const recs = [
    { id: 'a', type: 'lesson', project: 'p1', created_at: OLD, text: '教训一' },
    { id: 'b', type: 'lesson', project: 'p1', created_at: OLD - 3600, text: '教训二' },
    { id: 'c', type: 'lesson', project: 'p1', created_at: OLD - 7200, text: '教训三' },
    { id: 'd', type: 'decision', project: 'p1', created_at: OLD, text: '孤 decision' }, // 同组仅 1 条
  ]
  const groups = groupTierCandidates(recs, NOW)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].ids.length, 3)
  assert.equal(groups[0].type, 'lesson')
  // 不同月不入同组
  const recs2 = [...recs.slice(0, 2), { id: 'e', type: 'lesson', project: 'p1', created_at: OLD - 45 * 86400, text: '上月' }]
  assert.equal(groupTierCandidates(recs2, NOW).length, 0) // 各组都 <3
})

test('fallbackDigest：含 [归档] 前缀/条数/项目月', () => {
  const d = fallbackDigest(['教训甲内容', '教训乙内容'], 'proj', '2026-06', 'lesson')
  assert.ok(d.includes('[归档]'))
  assert.ok(d.includes('proj'))
  assert.ok(d.includes('2026-06'))
  assert.ok(d.includes('2 条'))
})

test('tierAge apply：创建摘要 + supersede 原始条目（可逆链）', async () => {
  // 内存假引擎
  const mem = new Map<string, { id: string; type: string; project: string; created_at: number; superseded_by?: string; text: string }>()
  let seq = 0
  const mk = (id: string, type: string, text: string): void => { mem.set(id, { id, type, project: 'p', created_at: OLD, text }) }
  mk('a', 'lesson', 'P0 - 教训A'); mk('b', 'lesson', 'P0 - 教训B'); mk('c', 'lesson', 'P0 - 教训C')
  const engine = {
    remember: async (text: string, o: { type: string; project: string; createdAt?: number }) => {
      const id = 'digest-' + (++seq)
      mem.set(id, { id, type: o.type, project: o.project, created_at: o.createdAt ?? NOW, text, superseded_by: undefined })
      return { status: 'created', id }
    },
    markSuperseded: async (oldId: string, newId: string) => { mem.get(oldId)!.superseded_by = newId; return true },
    store: { scan: () => [...mem.values()].map(r => [r, 0] as [{ id: string; type: string; project: string; created_at: number; superseded_by?: string; text: string }, number]) },
  } as never as Parameters<typeof tierAge>[0]

  const report = await tierAge(engine, async (sys, user) => {
    assert.ok(sys.length > 0)
    return 'P0 项目教训归档摘要。'
  }, { apply: true })

  assert.equal(report.groupsFound, 1)
  assert.equal(report.digestsCreated, 1)
  assert.equal(report.archived, 3)
  // 原始条目已沉底（superseded），摘要可查
  const digestRow = [...mem.values()].find(r => r.id.startsWith('digest-'))
  assert.ok(digestRow !== undefined && digestRow.text.includes('[归档]'))
  assert.equal(mem.get('a')!.superseded_by, digestRow!.id)
})

test('tierAge：LLM 失败 → 降级拼接照常归档', async () => {
  const mem = new Map<string, { id: string; type: string; project: string; created_at: number; text: string }>()
  let seq = 0
  const mk = (id: string, text: string): void => { mem.set(id, { id, type: 'decision', project: 'p', created_at: OLD, text }) }
  mk('x1', '决策一'); mk('x2', '决策二'); mk('x3', '决策三')
  const engine = {
    remember: async (text: string, o: { type: string; project: string }) => {
      const id = 'd-' + (++seq)
      mem.set(id, { id, type: 'lesson', project: 'p', created_at: NOW, text })
      return { status: 'created', id }
    },
    markSuperseded: async () => true,
    store: { scan: () => [...mem.values()].map(r => [r, 0] as never) },
  } as never as Parameters<typeof tierAge>[0]
  const bad: TierCompleteFn = async () => { throw new Error('provider down') }
  const report = await tierAge(engine, bad, { apply: true })
  assert.equal(report.llmUsed, false)
  assert.ok(report.digestsCreated >= 1, '降级拼接也要归档')
})
