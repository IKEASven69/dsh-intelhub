/** D3 任务卡协议单测：解析/序列化/状态机/upsert/AGENTS.md。 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENTS_MD, ensureAgentsMd, makeCard, newTaskId, parseTaskDoc,
  serializeCard, serializeCards, setCardStatus, upsertCard, type TaskFs,
} from '../src/tasks.ts'

const dir = mkdtempSync(join(tmpdir(), `dsh-deck-d3-${Date.now().toString(36)}-`))
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 残留不阻断 */ } })

function memFs(files: Map<string, string>): TaskFs {
  return {
    read: (p) => files.get(p) ?? null,
    write: (p, c) => { files.set(p, c) },
    exists: (p) => files.has(p),
    mkdirs: () => {},
  }
}

describe('parseTaskDoc', () => {
  it('单卡（adoptIdea 格式）：fm acceptance 拆分 + 标题回退 H1', () => {
    const md = [
      '---',
      'id: 20260825-101530-x',
      'type: research',
      'status: queued',
      'engine: zcode',
      'acceptance: 产出一篇带来源的调研事实稿',
      '---',
      '# 调研：预测市场流动性',
      '',
      '来自点子 xxx。',
      '',
      '---',
      '',
    ].join('\n')
    const cards = parseTaskDoc(md)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.id).toBe('20260825-101530-x')
    expect(cards[0]!.title).toBe('调研：预测市场流动性')
    expect(cards[0]!.acceptance).toEqual(['产出一篇带来源的调研事实稿'])
  })

  it('多卡 + 状态/类型未知回退默认 + body 验收 checkbox 回退', () => {
    const a = makeCard({ id: 'T-20260825-01', title: '已接单的卡' }, new Date())
    a.status = 'running'
    const b = makeCard({
      id: 'T-20260825-02', type: 'article', title: '写文章',
      body: '正文。\n\n## 验收\n\n- [ ] 800 字以上\n- [x] 有标题\n\n## 其他\n\n- 不该被抓',
    }, new Date())
    const cards = parseTaskDoc(serializeCards([a, b]))
    expect(cards).toHaveLength(2)
    expect(cards[0]!.status).toBe('running')
    expect(cards[0]!.type).toBe('research')
    expect(cards[1]!.acceptance).toEqual(['800 字以上', '有标题'])
  })

  it('往返：serializeCards(parse(md)) 稳定（adoptIdea 追加格式兼容）', () => {
    const md = '---\nid: a\ntype: research\nstatus: queued\nengine: zcode\nacceptance: 第一条；第二条\n---\n\n# 甲\n\n正文A\n\n---\n\n---\nid: b\ntype: ppt\nstatus: done\n---\n\n# 乙\n\n正文B'
    const once = serializeCards(parseTaskDoc(md))
    const twice = serializeCards(parseTaskDoc(once))
    expect(twice).toBe(once)
    const cards = parseTaskDoc(once)
    expect(cards[0]!.acceptance).toEqual(['第一条', '第二条'])
    expect(cards[1]!.status).toBe('done')
  })

  it('非卡片段（如文件头说明）被忽略；空文档返回空数组', () => {
    expect(parseTaskDoc('# 任务队列\n\n（空）')).toEqual([])
    expect(parseTaskDoc('')).toEqual([])
    const md = '# 任务队列\n\n说明文字。\n\n---\n\n---\nid: only\n---\n\n# 唯一'
    const cards = parseTaskDoc(md)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.id).toBe('only')
  })
})

describe('upsert / 状态机 / id 生成', () => {
  it('upsertCard 追加新卡、按 id 替换旧卡', () => {
    const base = '---\nid: T-1\nstatus: queued\n---\n\n# 一'
    const added = upsertCard(base, makeCard({ id: 'T-2', title: '二' }, new Date('2026-08-25T09:00:00Z')))
    expect(parseTaskDoc(added)).toHaveLength(2)
    const replaced = upsertCard(added, { ...parseTaskDoc(added)[0]!, status: 'running' })
    const cards = parseTaskDoc(replaced)
    expect(cards).toHaveLength(2)
    expect(cards[0]!.status).toBe('running')
  })

  it('setCardStatus 找到改状态；找不到返回 null', () => {
    const md = serializeCard(makeCard({ id: 'T-9', title: '九' }, new Date()))
    const next = setCardStatus(md, 'T-9', 'review')
    expect(parseTaskDoc(next!)[0]!.status).toBe('review')
    expect(setCardStatus(md, 'nope', 'done')).toBeNull()
  })

  it('newTaskId 同日自增、跨日归 1', () => {
    const taken = ['T-20260825-01', 'T-20260825-02']
    expect(newTaskId(new Date(2026, 7, 25), taken)).toBe('T-20260825-03')
    expect(newTaskId(new Date(2026, 7, 26), taken)).toBe('T-20260826-01')
  })
})

describe('AGENTS.md', () => {
  it('缺失时写入（内容含接单协议），存在时不覆盖', () => {
    const files = new Map<string, string>()
    const fs = memFs(files)
    const root = join(dir, 'proj')
    expect(ensureAgentsMd(fs, root)).toBe(true)
    expect(files.get(join(root, 'AGENTS.md'))).toBe(AGENTS_MD)
    expect(AGENTS_MD).toContain('status: queued')
    expect(AGENTS_MD).toContain('RESULT.md')
    files.set(join(root, 'AGENTS.md'), '# 用户自己的规则')
    expect(ensureAgentsMd(fs, root)).toBe(false)
    expect(files.get(join(root, 'AGENTS.md'))).toBe('# 用户自己的规则')
  })
})
