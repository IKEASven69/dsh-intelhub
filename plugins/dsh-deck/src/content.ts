/**
 * D4 自媒体台内容层：一篇内容 = content/{slug}/ 一个文件夹。
 * meta.md 是状态唯一源（status: idea|drafting|ready|prefill|published，
 * type: article|video|ppt）；三形态各有起步模板文件。纯函数，fs 注入可测。
 * @module dsh-deck/content
 */
import { join } from 'node:path'
import { parseDoc, serializeDoc, updateFrontmatter } from './frontmatter.ts'
import { slugify } from './ideas.ts'

export type ContentStatus = 'idea' | 'drafting' | 'ready' | 'prefill' | 'published'
export type ContentType = 'article' | 'video' | 'ppt'

export const CONTENT_STATUSES: readonly ContentStatus[] = ['idea', 'drafting', 'ready', 'prefill', 'published']
export const CONTENT_TYPES: readonly ContentType[] = ['article', 'video', 'ppt']

export interface ContentItem {
  slug: string
  title: string
  type: ContentType
  status: ContentStatus
  platforms: string
  created: string
  files: string[]
}

export interface ContentFs {
  list(dir: string): string[]
  isDir(path: string): boolean
  read(path: string): string | null
  write(path: string, content: string): void
  mkdirs(path: string): void
  exists(path: string): boolean
}

export const ACCEPTANCE_BY_TYPE: Record<ContentType, string[]> = {
  article: ['成稿 ≥800 字，可读性优先', '结构清晰（钩子/论点/收尾）', '引用来源逐条标注'],
  video: ['口播稿完整可念', '分镜表（时间轴/画面/字幕）', '素材清单齐备'],
  ppt: ['逐页标题 + 每页要点 ≤5 条', '产出可预览的 html（写入本目录）', '写 widget-result.json 指向产物'],
}

/** 扫描内容根：有 meta.md 的目录才算内容项；坏 meta 跳过。 */
export function listContent(fs: ContentFs, root: string): ContentItem[] {
  const out: ContentItem[] = []
  for (const slug of fs.list(root)) {
    if (!fs.isDir(join(root, slug))) continue
    const metaPath = join(root, slug, 'meta.md')
    const raw = fs.read(metaPath)
    if (raw === null) continue
    const { data } = parseDoc(raw)
    const type = (CONTENT_TYPES as readonly string[]).includes(data.type) ? data.type as ContentType : 'article'
    const status = (CONTENT_STATUSES as readonly string[]).includes(data.status) ? data.status as ContentStatus : 'idea'
    out.push({
      slug,
      title: (data.title ?? '').trim() || titleOfTopic(fs, root, slug) || slug,
      type,
      status,
      platforms: data.platforms ?? '',
      created: data.created ?? '',
      files: fs.list(join(root, slug)).filter((n) => n.endsWith('.md') || n.endsWith('.html') || n.endsWith('.json')).slice(0, 30),
    })
  }
  return out.sort((a, b) => (a.created < b.created ? 1 : -1))
}

function titleOfTopic(fs: ContentFs, root: string, slug: string): string {
  const raw = fs.read(join(root, slug, '选题.md'))
  if (raw === null) return ''
  const m = raw.match(/^#\s+(.+)$/m)
  return m !== null ? m[1]!.trim().slice(0, 80) : ''
}

/** 建内容项：slug 去重（-2 -3…），脚手架 = meta + 选题 + 三形态模板 + 素材/ + 发布记录。 */
export function createContent(fs: ContentFs, root: string, input: { title: string; type: ContentType; platforms?: string }, now: Date): ContentItem {
  const title = input.title.trim().slice(0, 120)
  if (title === '') throw new Error('标题必填')
  let slug = slugify(title)
  if (slug === 'idea') slug = 'topic'
  let n = 1
  let dir = join(root, slug)
  while (fs.exists(join(dir, 'meta.md'))) {
    n += 1
    dir = join(root, `${slug}-${n}`)
  }
  slug = dir === join(root, slug) ? slug : `${slug}-${n}`
  const date = now.toISOString().slice(0, 10)
  fs.mkdirs(join(dir, '素材'))
  fs.write(join(dir, 'meta.md'), serializeDoc(
    { status: 'idea', type: input.type, title, platforms: input.platforms ?? '', created: date },
    `# ${title}\n`,
  ))
  fs.write(join(dir, '选题.md'), `# ${title}\n\n（选题说明：给谁看、核心观点、参考资料。）\n`)
  for (const [name, body] of Object.entries(templateFiles(input.type, title))) fs.write(join(dir, name), body)
  fs.write(join(dir, '发布记录.md'), `# 发布记录\n\n| 日期 | 平台 | 链接/结果 | 备注 |\n|---|---|---|---|\n`)
  return { slug, title, type: input.type, status: 'idea', platforms: input.platforms ?? '', created: date, files: [] }
}

/** 三形态起步模板（占位结构，zcode/人往里填）。 */
export function templateFiles(type: ContentType, title: string): Record<string, string> {
  if (type === 'article') {
    return { '草稿.md': `# ${title}\n\n## 钩子\n\n## 论点\n\n1. \n\n## 收尾\n\n## 来源\n\n- \n` }
  }
  if (type === 'video') {
    return {
      '脚本.md': `# ${title} · 口播稿\n\n（目标时长：__ 分钟）\n`,
      '分镜.md': `# ${title} · 分镜\n\n| 时间 | 画面 | 字幕/口播 |\n|---|---|---|\n| 0:00 | | |\n`,
    }
  }
  return { 'PPT.md': `# ${title} · PPT 大纲\n\n## P1 封面：${title}\n\n- \n\n## P2\n\n- \n` }
}

/** meta 状态流转（写回 frontmatter，保 body）。找不到返回 null。 */
export function setContentStatus(fs: ContentFs, root: string, slug: string, status: ContentStatus): ContentItem | null {
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || slug === '') return null
  const metaPath = join(root, slug, 'meta.md')
  const raw = fs.read(metaPath)
  if (raw === null) return null
  fs.write(metaPath, updateFrontmatter(raw, { status }))
  const items = listContent(fs, root)
  return items.find((i) => i.slug === slug) ?? null
}
