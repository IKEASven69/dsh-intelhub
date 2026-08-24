/**
 * 点子库：kb/ideas/*.md，一念一文件。捕获（seed）→ 流转（incubating）→ 采纳
 * （picked，出口=调研任务卡 TASK.md 或选题文件夹 content/{slug}/）。
 * fs 操作注入可测。
 * @module dsh-deck/ideas
 */
import { join } from 'node:path'
import { parseDoc, serializeDoc, updateFrontmatter } from './frontmatter.ts'

export type IdeaStatus = 'seed' | 'incubating' | 'picked'

export interface Idea {
  file: string
  title: string
  status: IdeaStatus
  created: string
  body: string
}

export interface IdeasFs {
  list(dir: string): string[]
  read(path: string): string | null
  write(path: string, content: string): void
  exists(path: string): boolean
  mkdirs(path: string): void
}

export function slugify(text: string): string {
  const s = text.trim().slice(0, 40)
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return s === '' ? 'idea' : s
}

export function listIdeas(fs: IdeasFs, ideasDir: string): Idea[] {
  const out: Idea[] = []
  for (const name of fs.list(ideasDir)) {
    if (!name.endsWith('.md')) continue
    const raw = fs.read(join(ideasDir, name))
    if (raw === null) continue
    const { data, body } = parseDoc(raw)
    const status = (data.status === 'incubating' || data.status === 'picked') ? data.status : 'seed'
    out.push({
      file: name,
      title: firstLine(body) || name.replace(/\.md$/, ''),
      status,
      created: data.created ?? '',
      body: body.trim(),
    })
  }
  return out.sort((a, b) => (a.created < b.created ? 1 : -1))
}

function firstLine(body: string): string {
  const m = body.match(/^\s*#+\s*(.+)$/m) ?? body.match(/^\s*(\S.*)$/m)
  return m !== null ? m[1]!.trim().slice(0, 80) : ''
}

export function captureIdea(fs: IdeasFs, ideasDir: string, text: string, now: Date): string {
  const body = text.trim()
  if (body === '') throw new Error('点子内容为空')
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
  const file = `${stamp}-${slugify(firstLine(body) || body)}.md`
  const path = join(ideasDir, file)
  if (fs.exists(path)) throw new Error('文件已存在（同秒同名）')
  fs.write(path, serializeDoc(
    { status: 'seed', created: now.toISOString().slice(0, 10), source: 'deck' },
    `# ${firstLine(body) || body.slice(0, 40)}\n\n${body}\n`,
  ))
  return file
}

function p2(n: number): string { return String(n).padStart(2, '0') }

/**
 * 采纳：to='research' → 在目标项目根写/合并 TASK.md（任务卡协议）；
 * to='content' → content 根建 {slug}/meta.md + 选题.md。点子状态改 picked。
 */
export function adoptIdea(fs: IdeasFs, ideasDir: string, file: string, to: 'research' | 'content', projectRoot: string, contentRoot: string): { ok: true; created: string } {
  const ideaPath = join(ideasDir, file)
  const raw = fs.read(ideaPath)
  if (raw === null) return { ok: true, created: '' }
  const { body } = parseDoc(raw)
  const title = firstLine(body) || file
  let created = ''
  if (to === 'research') {
    const taskPath = join(projectRoot, 'TASK.md')
    const existing = fs.read(taskPath)
    const card = serializeDoc(
      { id: file.replace(/\.md$/, ''), type: 'research', status: 'queued', engine: 'zcode', acceptance: '产出一篇带来源的调研事实稿' },
      `# 调研：${title}\n\n来自点子 ${file}。\n\n${body.trim()}\n`,
    )
    if (existing === null) fs.write(taskPath, card)
    else if (!existing.includes(file)) fs.write(taskPath, existing.trimEnd() + '\n\n---\n\n' + card)
    created = taskPath
  } else {
    const slug = slugify(title)
    const dir = join(contentRoot, slug)
    fs.mkdirs(dir)
    fs.write(join(dir, 'meta.md'), serializeDoc(
      { status: 'idea', type: 'article', platforms: '', created: new Date().toISOString().slice(0, 10) },
      `# ${title}\n`,
    ))
    fs.write(join(dir, '选题.md'), `# ${title}\n\n来自点子 ${file}。\n\n${body.trim()}\n`)
    created = dir
  }
  fs.write(ideaPath, updateFrontmatter(raw, { status: 'picked' }))
  return { ok: true, created }
}
