/**
 * 知识库速览（合并自 knowledge-base quickview.ps1 的信息架构）：
 * 统计卡 + Skills 表 + 收藏 Top（互动量降序）+ 关注分渠道 + 待处理 + 判断回看。
 * 全只读，fs 注入可测。@module dsh-deck/quickview
 */
import { join } from 'node:path'

export interface QuickFs {
  read(path: string): string | null
}

export interface QuickWalk {
  list(): Array<[string, number]> // [相对路径, mtime ms]
}

export interface Quickview {
  stats: { skills: number; collections: number; raw: number; todayNew: number; lessonsWarn: number; watchChannels: number }
  skills: Array<{ name: string; desc: string; file: string }>
  hot: Array<{ title: string; heat: number; file: string; url: string }>
  watch: Array<{ channel: string; entries: Array<{ who: string; url: string; why: string }> }>
  raw: { count: number; latest: string[] }
  lessonsWarnList: string[]
}

export function buildQuickview(fs: QuickFs, walk: QuickWalk, kbRoot: string): Quickview {
  const files = walk.list()
  const readHead = (rel: string, n = 3000): string => (fs.read(join(kbRoot, rel)) ?? '').slice(0, n)

  // 全量文件分类
  const skillsFiles = files.filter(([p]) => /^skills\/[^/]+\/SKILL\.md$/i.test(p.replace(/\\/g, '/')))
  const collect = files.filter(([p]) => { const q = p.replace(/\\/g, '/'); return q.startsWith('collections/') && q.endsWith('.md') })
  const rawFiles = collect.filter(([p]) => p.replace(/\\/g, '/').startsWith('collections/all/'))
  const fine = collect.filter(([p]) => !p.replace(/\\/g, '/').startsWith('collections/all/') && !p.replace(/\\/g, '/').endsWith('watchlist.md'))
  const today = new Date(); const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const todayNew = collect.filter(([, m]) => m >= todayStart).length

  // Skills：名 = 目录名，desc = 第一个非标题行
  const skills = skillsFiles.map(([p]) => {
    const q = p.replace(/\\/g, '/')
    const name = q.split('/')[1]!
    const head = readHead(q, 1500)
    const desc = head.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? ''
    return { name, desc: desc.slice(0, 90), file: q }
  }).sort((a, b) => a.name.localeCompare(b.name))

  // 收藏热度：文件名/正文头的 最大 N♥
  const heatOf = (rel: string, head: string): number => {
    let max = 0
    for (const m of (rel + ' ' + head).matchAll(/(\d{1,6})\s*♥/g)) max = Math.max(max, Number(m[1]))
    return max
  }
  const hot = fine.map(([p]) => {
    const q = p.replace(/\\/g, '/')
    const head = readHead(q)
    const title = (head.match(/^#\s+(.+)$/m) ?? [])[1]?.trim().slice(0, 80) ?? q.split('/').pop()!
    const url = (head.match(/https?:\/\/[^\s)\]]+/) ?? [])[0] ?? ''
    return { title, heat: heatOf(q, head), file: q, url }
  }).sort((a, b) => b.heat - a.heat).slice(0, 20)

  // 关注分渠道：watchlist.md 的 ## 小节 + 列表行 [名](url) 理由
  const watch: Quickview['watch'] = []
  const wlRaw = fs.read(join(kbRoot, 'collections', 'watchlist.md'))
  if (wlRaw !== null) {
    let channel = '未分组'
    let cur: Quickview['watch'][number] | null = null
    for (const line of wlRaw.split(/\r?\n/)) {
      const h = line.match(/^#{1,3}\s+(.*)$/)
      if (h !== null) {
        if (cur !== null && cur.entries.length > 0) watch.push(cur)
        channel = h[1]!.trim().slice(0, 20)
        cur = { channel, entries: [] }
        continue
      }
      if (cur === null) cur = { channel, entries: [] }
      const m = line.match(/^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)(.*)$/)
      if (m !== null) cur.entries.push({ who: m[1]!.trim().slice(0, 40), url: m[2]!, why: m[3]!.replace(/^[\s—-]+/, '').trim().slice(0, 60) })
    }
    if (cur !== null && cur.entries.length > 0) watch.push(cur)
  }

  // LESSONS 待验证
  const lessons = fs.read(join(kbRoot, 'insights', 'LESSONS.md')) ?? ''
  const lessonsWarnList = lessons.split(/\r?\n/).filter((l) => l.includes('⚠️')).slice(-15).map((l) => l.replace(/^[-*\s\d.、]+/, '').slice(0, 120))

  return {
    stats: { skills: skills.length, collections: fine.length, raw: rawFiles.length, todayNew, lessonsWarn: lessonsWarnList.length, watchChannels: watch.length },
    skills, hot, watch,
    raw: { count: rawFiles.length, latest: rawFiles.slice().sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p.replace(/\\/g, '/')) },
    lessonsWarnList,
  }
}
