/**
 * dsh-deck 纯协议层：类型 + 项目 CRUD 归约器 + 校验（零宿主依赖，可单测）。
 * 状态形状见 PLAN.md「数据协议」；唯一持久化载体是 deck.json（host 路由读写）。
 * @module dsh-deck/protocol
 */

export type DeckTemplate = 'blank' | 'kb' | 'media'

export interface DeckProject {
  id: string
  name: string
  icon: string
  folder: string
  template: DeckTemplate
  layout: string
  order: number
  hidden: boolean
  bindSession?: string
}

export interface DeckAccountStatus {
  mode: string
  ok: boolean | null
  checkedAt?: string
}

export interface DeckMessage {
  id: string
  platform: string
  author: string
  text: string
  contentSlug: string
  time: string
  status: 'new' | 'drafted' | 'replied'
  reply: string
  repliedAt?: string
}

export interface DeckState {
  version: 1
  projects: DeckProject[]
  accounts: Record<string, DeckAccountStatus>
  pendingMount: Array<Record<string, unknown>>
  messages: DeckMessage[]
}

export function emptyDeck(): DeckState {
  return { version: 1, projects: [], accounts: {}, pendingMount: [], messages: [] }
}

/** 内置两台面 = 预注册模板实例（不可删，可隐藏）。 */
export function builtinProjects(kbFolder: string, mediaFolder: string): DeckProject[] {
  return [
    { id: 'builtin-kb', name: '知识调研台', icon: '🧠', folder: kbFolder, template: 'kb', layout: 'single', order: 0, hidden: false },
    { id: 'builtin-media', name: '自媒体台', icon: '🎬', folder: mediaFolder, template: 'media', layout: 'single', order: 1, hidden: false },
  ]
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

export interface ProjectInput {
  id?: string
  name?: unknown
  icon?: unknown
  folder?: unknown
  template?: unknown
  layout?: unknown
  order?: unknown
  hidden?: unknown
  bindSession?: unknown
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 && t.length <= max ? t : null
}

/** 校验并归一化一份项目输入（创建/更新共用）；folder 必须落在某个注册根内。 */
export function normalizeProject(input: ProjectInput, roots: readonly string[]): Result<Omit<DeckProject, 'id'>> {
  const name = input.name === undefined ? '' : str(input.name, 64)
  if (input.name !== undefined && name === null) return { ok: false, error: 'name 必须是 1-64 字符' }
  const icon = input.icon === undefined ? '📁' : str(input.icon, 16)
  if (icon === null) return { ok: false, error: 'icon 过长（≤16 字符）' }
  const folder = str(input.folder ?? '', 512)
  if (input.folder !== undefined && folder === null) return { ok: false, error: 'folder 非法' }
  const template = input.template === undefined ? 'blank' : input.template
  if (template !== 'blank' && template !== 'kb' && template !== 'media') {
    return { ok: false, error: `template 必须是 blank|kb|media，收到 ${String(template)}` }
  }
  const layout = input.layout === undefined ? 'single' : str(input.layout, 32)
  if (layout === null) return { ok: false, error: 'layout 非法' }
  let order = 100
  if (input.order !== undefined) {
    if (typeof input.order !== 'number' || !Number.isFinite(input.order)) return { ok: false, error: 'order 必须是数字' }
    order = Math.max(0, Math.min(9999, Math.round(input.order)))
  }
  const hidden = input.hidden === undefined ? false : input.hidden === true
  const bindSession = input.bindSession === undefined || input.bindSession === null
    ? undefined
    : str(input.bindSession, 128) ?? undefined
  if (folder !== '' && !withinAnyRoot(folder, roots)) {
    return { ok: false, error: `folder 必须位于注册根内（${roots.join(' | ')}）` }
  }
  return { ok: true, value: { name: name ?? '', icon, folder, template, layout, order, hidden, ...(bindSession !== undefined ? { bindSession } : {}) } }
}

function withinAnyRoot(folder: string, roots: readonly string[]): boolean {
  const abs = pathNormalize(folder)
  return roots.some((r) => {
    const root = pathNormalize(r)
    return abs === root || abs.startsWith(root + '/')
  })
}

function pathNormalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function createProject(state: DeckState, input: ProjectInput, roots: readonly string[]): Result<{ state: DeckState; project: DeckProject }> {
  const norm = normalizeProject(input, roots)
  if (!norm.ok) return norm
  if (norm.value.name === '') return { ok: false, error: '创建时 name 必填' }
  const id = typeof input.id === 'string' && ID_RE.test(input.id)
    ? input.id
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  if (state.projects.some((p) => p.id === id)) return { ok: false, error: `id 已存在：${id}` }
  const project: DeckProject = { id, ...norm.value }
  const projects = [...state.projects, project].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return { ok: true, value: { state: { ...state, projects }, project } }
}

export function updateProject(state: DeckState, id: string, input: ProjectInput, roots: readonly string[]): Result<DeckState> {
  const idx = state.projects.findIndex((p) => p.id === id)
  if (idx === -1) return { ok: false, error: `项目不存在：${id}` }
  const cur = state.projects[idx]!
  if (typeof input.id === 'string' && input.id !== id) return { ok: false, error: '不允许改 id' }
  const norm = normalizeProject({ ...cur, ...input, name: input.name ?? cur.name, folder: input.folder ?? cur.folder }, roots)
  if (!norm.ok) return norm
  const merged: DeckProject = { id, ...norm.value, bindSession: norm.value.bindSession ?? cur.bindSession }
  const projects = state.projects.slice()
  projects[idx] = merged
  const sorted = projects.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return { ok: true, value: { ...state, projects: sorted } }
}

export function deleteProject(state: DeckState, id: string): Result<DeckState> {
  const target = state.projects.find((p) => p.id === id)
  if (target === undefined) return { ok: false, error: `项目不存在：${id}` }
  if (target.id.startsWith('builtin-')) return { ok: false, error: '内置台面不可删除（可隐藏）' }
  return { ok: true, value: { ...state, projects: state.projects.filter((p) => p.id !== id) } }
}
