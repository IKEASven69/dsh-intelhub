/**
 * 放行清单写回的纯函数层：pnpm 11 allowBuilds（pnpm-workspace.yaml）与 npm 12 allowScripts（package.json）。
 * 键名与形状依据（2026-08 核实）：pnpm 11 在 pnpm-workspace.yaml 用 `allowBuilds:` 名到布尔映射
 * （deepseek-ai/deepseek-harness 官方参考文档与 openclaw 等真实仓库一致）；npm 12 在 package.json 用
 * `allowScripts` 映射，`false` 为显式拒绝。
 * 设计纪律（对齐 README Honest limits 与 LESSONS 六-4）：
 * - 显式拒绝（false）永不被自动翻转——那是用户的决定，不是工具的；
 * - 只重写我们管理的 allowBuilds 块 / allowScripts 键，其余内容原样保留；
 * - 块内出现无法理解的形态时拒绝写入而不是硬改——宁可放弃，不可写坏。
 * - 排序用 Ordinal 比较，禁 locale 感知（LESSONS 六-6）。
 */

export interface AllowBuildsParse {
  ok: boolean
  error?: string
  /** allowBuilds 名 → 布尔（true=已放行，false=显式拒绝） */
  entries: Map<string, boolean>
  /** 块在原文件中的行区间 [start, end)；未找到块时缺省 */
  block?: { start: number; end: number }
}

const TOP_LEVEL = /^\S/
const ENTRY = /^(\s+)"?([^":]+?)"?\s*:\s*(true|false)\s*$/
const KEY = /^allowBuilds\s*:/

export function parseAllowBuildsYaml(text: string | undefined): AllowBuildsParse {
  if (text === undefined || text.trim() === '') return { ok: true, entries: new Map() }
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (KEY.test(lines[i])) {
      start = i
      break
    }
  }
  if (start === -1) return { ok: true, entries: new Map() }
  const entries = new Map<string, boolean>()
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i]
    if (ln.trim() === '') continue
    if (TOP_LEVEL.test(ln)) {
      end = i
      break
    }
    const m = ln.match(ENTRY)
    if (m !== null) {
      entries.set(m[2], m[3] === 'true')
      continue
    }
    // pnpm 11 拦截安装后会在 allowBuilds 里生成占位提示行（值就是这句原话），
    // 语义是「未设置」而非「拒绝」——视为空，允许工具安全写入真实决定。
    const ph = ln.match(/^(\s+)"?([^":]+?)"?\s*:\s*(.+)$/)
    if (ph !== null && ph[3].trim() === 'set this to true or false') continue
    return { ok: false, error: `第 ${i + 1} 行不是「"包名": true|false」形态`, entries, block: { start, end } }
  }
  return { ok: true, entries, block: { start, end } }
}

export interface AllowBuildsWrite {
  ok: boolean
  error?: string
  /** 完整的新 yaml 文本；ok=false 时缺省 */
  text?: string
  added: string[]
  skippedDenied: string[]
}

export function mergeAllowBuildsYaml(text: string | undefined, packages: string[]): AllowBuildsWrite {
  const parse = parseAllowBuildsYaml(text)
  if (!parse.ok) return { ok: false, error: parse.error, added: [], skippedDenied: [] }
  const entries = new Map(parse.entries)
  const added: string[] = []
  const skippedDenied: string[] = []
  for (const p of packages) {
    const cur = entries.get(p)
    if (cur === false) {
      skippedDenied.push(p)
      continue
    }
    if (cur !== true) {
      entries.set(p, true)
      added.push(p)
    }
  }
  const lines = (text ?? '').split(/\r?\n/)
  const blockLines = [
    'allowBuilds:',
    ...[...entries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `  "${k}": ${v}`),
  ]
  let out: string[]
  if (parse.block === undefined) {
    const base = text === undefined || text.trim() === '' ? [] : lines
    const sep = base.length > 0 && base[base.length - 1]!.trim() !== '' ? [''] : []
    out = [...base, ...sep, ...blockLines]
  } else {
    out = [...lines.slice(0, parse.block.start), ...blockLines, ...lines.slice(parse.block.end)]
  }
  return { ok: true, text: out.join('\n') + '\n', added, skippedDenied }
}

export interface AllowScriptsWrite {
  doc: Record<string, unknown>
  added: string[]
  skippedDenied: string[]
}

/** npm 12：package.json 的 allowScripts 映射。显式 false 拒绝不翻转；现有 true 保留；其余键原样保留。 */
export function mergeAllowScriptsDoc(doc: Record<string, unknown>, packages: string[]): AllowScriptsWrite {
  const cur = (doc.allowScripts as Record<string, unknown> | undefined) ?? {}
  const entries: Record<string, unknown> = { ...cur }
  const added: string[] = []
  const skippedDenied: string[] = []
  for (const p of packages) {
    if (entries[p] === false) {
      skippedDenied.push(p)
      continue
    }
    if (entries[p] !== true) {
      entries[p] = true
      added.push(p)
    }
  }
  return { doc: { ...doc, allowScripts: entries }, added, skippedDenied }
}
