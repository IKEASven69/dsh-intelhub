/**
 * 极简 frontmatter 解析/序列化（零依赖，可单测）。
 * 只支持平铺 string 字段（knowledge-base 生态够用），不嵌套。
 * @module dsh-deck/frontmatter
 */

export interface ParsedDoc {
  data: Record<string, string>
  body: string
}

export function parseDoc(text: string): ParsedDoc {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const header = text.slice(3, end).replace(/^[ \t]*\r?\n/, '')
  const bodyStart = text.indexOf('\n', end + 4)
  const body = bodyStart === -1 ? '' : text.slice(bodyStart + 1)
  const data: Record<string, string> = {}
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (m === null) continue
    const key = m[1]!
    let v = m[2]!.trim()
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1)
    data[key] = v
  }
  return { data, body }
}

export function serializeDoc(data: Record<string, string>, body: string): string {
  const lines = Object.entries(data).map(([k, v]) => {
    const safe = /[:#"\n]/.test(v) ? JSON.stringify(v) : v
    return `${k}: ${safe}`
  })
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}

/** 更新已有文档的 frontmatter 字段（保留 body 与字段顺序，新键追加）。 */
export function updateFrontmatter(text: string, patch: Record<string, string>): string {
  const { data, body } = parseDoc(text)
  const merged: Record<string, string> = {}
  for (const k of Object.keys(data)) merged[k] = patch[k] ?? data[k]!
  for (const k of Object.keys(patch)) if (!(k in merged)) merged[k] = patch[k]!
  return serializeDoc(merged, body)
}
