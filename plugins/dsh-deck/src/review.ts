/**
 * D3下 审阅与落库：解析 agent 产出的 RESULT.md（fm task/type/summary + 正文
 * 「## 判断」无序列表 + 「## 来源」），勾选判断续接进 insights/LESSONS.md
 * 新章节（中文序号节 + 节内 1..n 编号 + 节尾日期行）。纯函数，fs 注入可测。
 * @module dsh-deck/review
 */
import { parseDoc } from './frontmatter.ts'

export interface ResultDoc {
  task: string
  type: string
  summary: string
  judgments: string[]
  sources: string[]
  body: string
}

export interface WidgetWindow {
  target: string
  kind: string
  path?: string
  url?: string
  html?: string
}

export function parseResultDoc(md: string): ResultDoc {
  const { data, body } = parseDoc(md)
  const b = body.trim()
  return {
    task: data.task ?? '',
    type: data.type ?? '',
    summary: data.summary ?? '',
    judgments: sectionItems(b, /判断|结论|insight/i),
    sources: sectionItems(b, /来源|source/i),
    body: b,
  }
}

/** 取「## <name 匹配>」小节里的列表项文本（- / * / 1. 皆可）。 */
function sectionItems(body: string, nameRe: RegExp): string[] {
  const out: string[] = []
  let inSection = false
  for (const line of body.split(/\r?\n/)) {
    const hd = line.match(/^#{1,6}\s+(.*)$/)
    if (hd !== null) { inSection = nameRe.test(hd[1]!); continue }
    if (!inSection) continue
    const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)
    if (m !== null) out.push(m[1]!.trim())
  }
  return out
}

/** 防御式解析 widget-result.json；形状不对返回 null。 */
export function parseWidgetJson(text: string | null): { task: string; windows: WidgetWindow[] } | null {
  if (text === null || text.trim() === '') return null
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    if (j === null || typeof j !== 'object') return null
    const windowsRaw = Array.isArray(j.windows) ? j.windows : []
    const windows = windowsRaw
      .filter((w): w is Record<string, unknown> => w !== null && typeof w === 'object')
      .filter((w) => typeof w.kind === 'string' && (typeof w.path === 'string' || typeof w.url === 'string' || typeof w.html === 'string'))
      .map((w) => ({
        target: typeof w.target === 'string' ? w.target : 'main',
        kind: String(w.kind),
        ...(typeof w.path === 'string' ? { path: w.path } : {}),
        ...(typeof w.url === 'string' ? { url: w.url } : {}),
        ...(typeof w.html === 'string' ? { html: w.html } : {}),
      }))
    return { task: typeof j.task === 'string' ? j.task : '', windows }

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** 1→一 … 19→十九 20→二十 21→二十一 … 99（够用；>99 原样返回数字）。 */
export function chineseNumeral(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 99) return String(n)
  if (n < 10) return CN[n]!
  const tens = Math.floor(n / 10)
  const ones = n % 10
  return (tens > 1 ? CN[tens]! : '') + '十' + (ones > 0 ? CN[ones]! : '')
}

/** 从 LESSONS.md 现有 `## 一、` 标题推断下一个章节号。 */
export function nextSectionNo(lessonsMd: string): number {
  let max = 0
  const re = /^##\s+([一二三四五六七八九十]{1,3})、/gm
  const idx: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  for (const m of lessonsMd.matchAll(re)) {
    const s = m[1]!
    let v = 0
    for (const ch of s) v = v * 10 + (idx[ch] ?? 0)
    if (v === 0 && s === '十') v = 10
    if (v > max) max = v
  }
  return max + 1
}

export interface ApproveMeta {
  taskId: string
  taskTitle: string
  date: string
}

/** 生成追加到 LESSONS.md 末尾的新章节文本。 */
export function buildLessonsSection(lessonsMd: string, picks: readonly string[], meta: ApproveMeta): string {
  const no = nextSectionNo(lessonsMd)
  const head = `## ${chineseNumeral(no)}、Deck 落库（${meta.date}，${meta.taskId}：${meta.taskTitle}）`
  const lines = picks.map((p, i) => `${i + 1}. ${stripListMark(p)} \`⚠️待验证\`——来自 deck 调研任务 ${meta.taskId}（${meta.taskTitle}）。`)
  const tail = `_日期：${meta.date}。来源：zcode 调研 → 人工勾选落库（dsh-deck 审阅台）。_`
  const glue = lessonsMd.trimEnd() === '' ? '' : '\n\n'
  return `${glue}${head}\n\n${lines.join('\n')}\n\n${tail}\n`
}

function stripListMark(s: string): string {
  const t = s.trim()
  return t.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '')
}
