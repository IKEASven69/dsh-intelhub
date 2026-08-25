/** D3下 审阅/落库单测：RESULT 解析、widget 防御解析、LESSONS 章节续接。 */
import { describe, expect, it } from 'vitest'
import { AGENTS_MD, ensureAgentsMd, type TaskFs } from '../src/tasks.ts'
import { buildLessonsSection, chineseNumeral, nextSectionNo, parseResultDoc, parseWidgetJson } from '../src/review.ts'

const RESULT_MD = [
  '---',
  'task: T-20260825-01',
  'type: research',
  'summary: 流动性决定价格发现',
  '---',
  '',
  '# 调研：预测市场流动性',
  '',
  '## 判断',
  '',
  '- 流动性深度比手续费更影响价格发现效率',
  '- 2. **长尾市场做市不可持续**：价差覆盖不了库存风险',
  '',
  '## 来源',
  '',
  '- https://example.com/paper —— 实证研究',
  '- D:/kb/xxx.md —— 本地笔记',
  '',
  '## 过程',
  '',
  '扫了 5 个来源，跳过 1 个付费墙。',
].join('\n')

describe('parseResultDoc', () => {
  it('fm + 判断/来源 小节解析', () => {
    const r = parseResultDoc(RESULT_MD)
    expect(r.task).toBe('T-20260825-01')
    expect(r.summary).toBe('流动性决定价格发现')
    expect(r.judgments).toHaveLength(2)
    expect(r.judgments[0]).toBe('流动性深度比手续费更影响价格发现效率')
    expect(r.sources).toHaveLength(2)
  })
  it('无小节时回退空数组；残缺 fm 不炸', () => {
    const r = parseResultDoc('# 只有正文\n\n没有小节。')
    expect(r.judgments).toEqual([])
    expect(r.task).toBe('')
  })
})

describe('parseWidgetJson', () => {
  it('合法 windows 解析 + 字段透传', () => {
    const w = parseWidgetJson('{"task":"T-1","windows":[{"target":"main","kind":"html","html":"<b>hi</b>"},{"kind":"url","url":"https://a"},{"kind":"file","path":"out/a.html","target":"窗口2"},{"kind":"bad"}],"generatedAt":"x"}')
    expect(w).not.toBeNull()
    expect(w!.task).toBe('T-1')
    expect(w!.windows).toHaveLength(3)
    expect(w!.windows[1]).toEqual({ target: 'main', kind: 'url', url: 'https://a' })
  })
  it('空/坏 JSON 返回 null', () => {
    expect(parseWidgetJson(null)).toBeNull()
    expect(parseWidgetJson('')).toBeNull()
    expect(parseWidgetJson('{oops')).toBeNull()
    expect(parseWidgetJson('{"task":"T"}')).toBeNull()
  })
})

describe('LESSONS 章节续接', () => {
  const lessons = [
    '# Lessons — 复盘沉淀',
    '',
    '## 一、产品与传播',
    '',
    '1. 第一条',
    '',
    '## 七、内容判断',
    '',
    '1. 老七',
    '',
    '_日期：2026-08-23。_',
  ].join('\n')

  it('nextSectionNo 取最大中文序号+1；chineseNumeral 边界', () => {
    expect(nextSectionNo(lessons)).toBe(8)
    expect(nextSectionNo('')).toBe(1)
    expect(chineseNumeral(8)).toBe('八')
    expect(chineseNumeral(10)).toBe('十')
    expect(chineseNumeral(11)).toBe('十一')
    expect(chineseNumeral(20)).toBe('二十')
    expect(chineseNumeral(21)).toBe('二十一')
  })

  it('buildLessonsSection：八、新节 + 节内 1..n + 待验证标记 + 日期尾行', () => {
    const out = buildLessonsSection(lessons, ['- 流动性深度比手续费更影响价格发现效率', '2. **长尾市场做市不可持续**'], { taskId: 'T-20260825-01', taskTitle: '调研：预测市场流动性', date: '2026-08-25' })
    expect(out).toContain('## 八、Deck 落库（2026-08-25，T-20260825-01：调研：预测市场流动性）')
    expect(out).toContain('1. 流动性深度比手续费更影响价格发现效率 `⚠️待验证`')
    expect(out).toContain('2. **长尾市场做市不可持续** `⚠️待验证`')
    expect(out).toContain('_日期：2026-08-25。来源：zcode 调研 → 人工勾选落库')
    // 空文档时无前导空行
    expect(buildLessonsSection('', ['a'], { taskId: 'T', taskTitle: '题', date: 'd' }).startsWith('## 一、')).toBe(true)
  })
})

describe('AGENTS.md v2 升级', () => {
  it('v1（我们写的）自动升级 v2；用户改过的不动；已是 v2 不重写', () => {
    const files = new Map<string, string>()
    const fs: TaskFs = {
      read: (p) => files.get(p) ?? null,
      write: (p, c) => { files.set(p, c) },
      exists: (p) => files.has(p),
      mkdirs: () => {},
    }
    const v1 = AGENTS_MD.replace('deck:agents:v2', 'deck:agents:v1').replace('· v2', '')
    files.set('AGENTS.md', v1)
    expect(ensureAgentsMd(fs, '.')).toBe(true)
    expect(files.get('AGENTS.md')).toBe(AGENTS_MD)
    expect(ensureAgentsMd(fs, '.')).toBe(false)
    files.set('AGENTS.md', '# 用户自己的规则')
    expect(ensureAgentsMd(fs, '.')).toBe(false)
    expect(files.get('AGENTS.md')).toBe('# 用户自己的规则')
  })
})
