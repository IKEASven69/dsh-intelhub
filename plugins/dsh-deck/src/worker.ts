/**
 * 速览 Worker Thread：把 28k 文件扫描从主线程移到子线程，根治事件循环阻塞。
 * 主线程通过 postMessage 请求构建，Worker 完成后回传结果。
 */
import { Worker } from 'node:worker_threads'

// Worker 内执行的代码（内联字符串，不需要独立文件）
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads')
const { readFileSync, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

// 纯函数版本的 quickview 构建（从 quickview.ts 复制核心逻辑，去 TS 类型）
function buildQuickviewWorker(kbRoot) {
  const walk = (dir) => {
    const out = []
    const SKIP = new Set(['.git', 'node_modules', 'panel-src', '.obsidian', '.trash'])
    const rec = (d) => {
      let names
      try { names = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of names) {
        if (e.name.startsWith('.') && SKIP.has(e.name)) continue
        if (SKIP.has(e.name)) continue
        if (e.name.startsWith('.') && e.isDirectory()) continue
        const full = join(d, e.name)
        if (e.isDirectory()) rec(full)
        else if (e.name.endsWith('.md')) {
          let m = 0
          try { m = statSync(full).mtimeMs } catch {}
          out.push([full, m])
        }
      }
    }
    rec(dir)
    return out
  }

  const files = walk(kbRoot)
  const readHead = (abs, n = 3000) => { try { return readFileSync(abs, 'utf8').slice(0, n) } catch { return '' } }

  const skillsFiles = files.filter(([p]) => /skills[/\\\\][^/\\\\]+[/\\\\]SKILL\\.md$/i.test(p))
  const collect = files.filter(([p]) => { const q = p.replace(/\\\\/g, '/'); return q.includes('/collections/') && p.endsWith('.md') })
  const rawFiles = collect.filter(([p]) => p.replace(/\\\\/g, '/').includes('/collections/all/'))
  const fine = collect.filter(([p]) => !p.replace(/\\\\/g, '/').includes('/collections/all/') && !p.replace(/\\\\/g, '/').endsWith('watchlist.md'))
  const todayStart = new Date(); todayStart.setHours(0,0,0,0)
  const todayNew = collect.filter(([, m]) => m >= todayStart.getTime()).length

  const skills = skillsFiles.map(([p]) => {
    const q = p.replace(/\\\\/g, '/')
    const name = q.split('/')[q.split('/').length - 2] || 'unknown'
    const head = readHead(p, 1500)
    const desc = head.split('\\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) || ''
    return { name, desc: desc.slice(0, 90), file: q }
  }).sort((a, b) => a.name.localeCompare(b.name))

  const heatOf = (rel, head) => {
    let max = 0
    for (const m of (rel + ' ' + head).matchAll(/(\\d{1,6})\\s*♥/g)) max = Math.max(max, Number(m[1]))
    return max
  }
  const hot = fine.map(([p]) => {
    const q = p.replace(/\\\\/g, '/')
    const head = readHead(p)
    const title = (head.match(/^#\\s+(.+)$/m) || [])[1] || q.split('/').pop() || ''
    const url = (head.match(/https?:\\/\\/[^\\s)\\]]+/) || [])[0] || ''
    return { title: title.slice(0, 80), heat: heatOf(q, head), file: q, url }
  }).sort((a, b) => b.heat - a.heat).slice(0, 20)

  const watch = []
  const wlRaw = (() => { try { return readFileSync(join(kbRoot, 'collections', 'watchlist.md'), 'utf8') } catch { return null } })()
  if (wlRaw) {
    let channel = '', cur = null
    for (const line of wlRaw.split('\\n')) {
      const h = line.match(/^#{1,3}\\s+(.*)$/)
      if (h) { if (cur && cur.entries.length) watch.push(cur); channel = h[1].slice(0, 20); cur = null; continue }
      if (!channel) continue
      const t = line.trim()
      if (!t.startsWith('|')) continue
      const cols = t.split('|').map(c => c.trim().replace(/\`/g, ''))
      if (cols.length < 4) continue
      const who = cols[1] || ''
      if (!who || who === '---' || who.startsWith('-')) continue
      const url = cols.find(c => c.startsWith('http')) || ''
      if (!url) continue
      if (!cur) cur = { channel, entries: [] }
      cur.entries.push({ who: who.slice(0, 40), url, why: (cols[4] || cols[3] || '').slice(0, 60), grp: (cols[2] || '').slice(0, 20) })
    }
    if (cur && cur.entries.length) watch.push(cur)
  }

  const lessons = (() => { try { return readFileSync(join(kbRoot, 'insights', 'LESSONS.md'), 'utf8') } catch { return '' } })()
  const lessonsWarnList = lessons.split('\\n').filter(l => l.includes('⚠️')).slice(-15).map(l => l.replace(/^[-*\\s\\d.、]+/, '').slice(0, 120))

  return {
    stats: { skills: skills.length, collections: fine.length, raw: rawFiles.length, todayNew, lessonsWarn: lessonsWarnList.length, watchChannels: watch.length },
    skills, hot, watch,
    raw: { count: rawFiles.length, latest: rawFiles.slice().sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p.replace(/\\\\/g, '/')) },
    lessonsWarnList,
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'build') {
    try {
      const data = buildQuickviewWorker(msg.kbRoot)
      parentPort.postMessage({ type: 'done', data })
    } catch (e) {
      parentPort.postMessage({ type: 'error', error: e.message })
    }
  }
})
`

// 主线程管理器
export class QuickviewWorker {
  private worker: Worker | null = null
  private pending: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null
  private cache: { data: unknown; at: number } | null = null
  private ttl: number

  constructor(ttlMs = 3 * 60 * 1000) {
    this.ttl = ttlMs
  }

  /** 取速览数据（缓存命中直接返回，过期则 Worker 重建——不阻塞主线程） */
  get(kbRoot: string): Promise<unknown> {
    if (this.cache !== null && Date.now() - this.cache.at < this.ttl) {
      return Promise.resolve(this.cache.data)
    }
    return this.build(kbRoot)
  }

  /** 在 Worker 中构建（主线程零阻塞） */
  build(kbRoot: string): Promise<unknown> {
    if (this.pending !== null) {
      return new Promise((resolve, reject) => {
        // 已有构建在进行中，等它完成后再从缓存拿
        setTimeout(() => { this.get(kbRoot).then(resolve).catch(reject) }, 500)
      })
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      try {
        if (this.worker === null) {
          this.worker = new Worker(WORKER_CODE, { eval: true })
          this.worker.on('message', (msg) => {
            if (msg.type === 'done') {
              this.cache = { data: msg.data, at: Date.now() }
              if (this.pending) { this.pending.resolve(msg.data); this.pending = null }
            } else if (msg.type === 'error') {
              if (this.pending) { this.pending.reject(new Error(msg.error)); this.pending = null }
            }
          })
          this.worker.on('error', (e) => {
            if (this.pending) { this.pending.reject(e); this.pending = null }
          })
        }
        this.worker.postMessage({ type: 'build', kbRoot })
      } catch (e) {
        this.pending = null
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  dispose(): void {
    if (this.worker !== null) { this.worker.terminate(); this.worker = null }
  }
}
