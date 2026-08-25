/**
 * dsh-deck — 工作台插件 host 半（D1 基座）。
 *
 * 路由（全部过 security.allowRequest：写方法强制同源 Origin）：
 *   GET  /api/deck/health
 *   GET  /api/deck/state                    → DeckState
 *   POST /api/deck/state                    → 整体覆写（审慎；用于拖拽排序等）
 *   POST /api/deck/project/create|update|delete
 *   POST /api/deck/fs/list|read|write|mkdir  {root, path[, content]}
 *
 * 根白名单（别名 → 绝对路径）：kb=knowledge-base，content=内容根，dsh=~/.dsh。
 * client 只传 POSIX 相对路径（resolveWithinRoot 做穿越检查）。
 * 状态：~/.dsh/storages/dsh-deck.json（原子写）。
 * 规格：plugins/dsh-deck/PLAN.md（唯一权威版本）。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DeckStore, deckDefaults, deckPath, nodeFs } from './state.ts'
import { allowRequest, readJsonBody, resolveWithinRoot, RootRegistry, type RequestLike } from './security.ts'
import { createProject, deleteProject, updateProject, type DeckState, type ProjectInput } from './protocol.ts'
import { KbIndex, nodeWalk } from './search.ts'
import { adoptIdea, captureIdea, listIdeas, type IdeasFs } from './ideas.ts'
import { ensureAgentsMd, makeCard, newTaskId, parseTaskDoc, setCardStatus, upsertCard, TASK_STATUSES, TASK_TYPES, type TaskCard, type TaskFs, type TaskStatus, type TaskType } from './tasks.ts'
import { buildLessonsSection, parseResultDoc, parseWidgetJson } from './review.ts'
import { ACCEPTANCE_BY_TYPE, appendPublishRow, buildPrefillText, createContent, listContent, PREFILL_TARGETS, setContentStatus, CONTENT_STATUSES, CONTENT_TYPES, type ContentFs, type ContentType, type ContentStatus } from './content.ts'
import { execFile } from 'node:child_process'
import { join as joinPath } from 'node:path'
import z from 'schemastery'

export const name = 'dsh-deck'
export const inject = ['webServer']

const KB_ROOT_DEFAULT = 'D:/coding/knowledge-base'
const CONTENT_ROOT_DEFAULT = 'D:/coding/content'

export interface Config {
  kbRoot: string
  contentRoot: string
  zcodeCli: string
}

const ZCODE_CLI_DEFAULT = 'D:/ProgrammingKit/Zcode/resources/glm/zcode.cjs'

export const Config = z.object({
  kbRoot: z.string().default(KB_ROOT_DEFAULT),
  contentRoot: z.string().default(CONTENT_ROOT_DEFAULT),
  zcodeCli: z.string().default(ZCODE_CLI_DEFAULT),
})

const roots = new RootRegistry()

function sendJson(res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }, code: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

export function apply(ctx: Context, config: Config): void {
  const kbRoot = resolve(config?.kbRoot ?? KB_ROOT_DEFAULT)
  const contentRoot = resolve(config?.contentRoot ?? CONTENT_ROOT_DEFAULT)
  const dshHome = join(homedir(), '.dsh')
  roots.register('kb', kbRoot)
  roots.register('content', contentRoot)
  roots.register('dsh', dshHome)
  const store = new DeckStore(deckPath(dshHome), nodeFs, deckDefaults(kbRoot, contentRoot))
  mkdirSync(contentRoot, { recursive: true })

  const guard = (req: RequestLike, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }): boolean => {
    if (allowRequest(req)) return true
    sendJson(res, 403, { ok: false, error: 'origin 校验失败（仅同源可访问）' })
    return false
  }

  const reg = (kind: 'exact' | 'prefix', path: string, handler: (req: any, res: any) => void | Promise<void>): void => {
    ctx.effect(() => (ctx as any).webServer.register({ kind, path, handler }), `dsh-deck: ${path}`)
  }

  reg('exact', '/api/deck/health', (_req, res) => {
    sendJson(res, 200, { plugin: name, version: '0.1.0', ok: true, roots: roots.aliases() })
  })

  reg('exact', '/api/deck/state', (req, res) => {
    if (!guard(req, res)) return
    if (req.method === 'GET') { sendJson(res, 200, store.get()); return }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return }
    void (async () => {
      const body = await readJsonBody(req, 2 * 1024 * 1024)
      if (body === null || typeof body !== 'object' || !Array.isArray((body as DeckState).projects)) {
        sendJson(res, 400, { ok: false, error: 'state 体非法' }); return
      }
      store.set(body as DeckState)
      sendJson(res, 200, { ok: true })
    })()
  })

  const projectRoute = (op: 'create' | 'update' | 'delete') => (req: any, res: any): void => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 256 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      const rootPaths = roots.aliases().map((a) => roots.resolveRoot(a)!) as unknown as string[]
      const state = store.get()
      if (op === 'create') {
        const r = createProject(state, body as ProjectInput, rootPaths)
        if (!r.ok) { sendJson(res, 400, { ok: false, error: r.error }); return }
        store.set(r.value.state)
        const p = r.value.project
        if (p.folder.trim() !== '') {
          try {
            const abs = resolve(p.folder)
            mkdirSync(abs, { recursive: true })
            ensureAgentsMd(taskFs, abs)
            const readme = joinPath(abs, 'README.md')
            if (!existsSync(readme)) writeFileSync(readme, `# ${p.name}\n\ndsh-deck 工作台项目（模板：${p.template}）。\n任务协议见 AGENTS.md；任务卡在 TASK.md。\n`, 'utf8')
          } catch { /* 脚手架失败不阻断注册 */ }
        }
        sendJson(res, 200, { ok: true, project: r.value.project })
        return
      }
      if (op === 'update') {
        const id = String((body as Record<string, unknown>).id ?? '')
        const r = updateProject(state, id, body as ProjectInput, rootPaths)
        if (!r.ok) { sendJson(res, 400, { ok: false, error: r.error }); return }
        store.set(r.value)
        sendJson(res, 200, { ok: true, state: r.value })
        return
      }
      const id = String((body as Record<string, unknown>).id ?? '')
      const r = deleteProject(state, id)
      if (!r.ok) { sendJson(res, 400, { ok: false, error: r.error }); return }
      store.set(r.value)
      sendJson(res, 200, { ok: true, state: r.value })
    })()
  }
  reg('exact', '/api/deck/project/create', projectRoute('create'))
  reg('exact', '/api/deck/project/update', projectRoute('update'))
  reg('exact', '/api/deck/project/delete', projectRoute('delete'))

  // ── D3：任务卡协议 + zcode 派发 ──
  const taskFs: TaskFs = {
    read: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
    write: (p, c) => { mkdirSync(dirnameOf(p), { recursive: true }); const t = p + '.tmp'; writeFileSync(t, c, 'utf8'); renameSync(t, p) },
    exists: (p) => existsSync(p),
    mkdirs: (p) => { mkdirSync(p, { recursive: true }) },
  }

  /** 项目 id → 绝对文件夹（须仍在注册根内，纵深防御）。 */
  const projectFolder = (id: string): { ok: true; folder: string } | { ok: false; error: string } => {
    const p = store.get().projects.find((x) => x.id === id)
    if (p === undefined) return { ok: false, error: `项目不存在：${id}` }
    if (p.folder.trim() === '') return { ok: false, error: `项目未绑定文件夹：${p.name}` }
    const abs = resolve(p.folder)
    const inside = roots.aliases().some((a) => {
      const r = resolve(roots.resolveRoot(a)!)
      return abs === r || abs.startsWith(r + sep)
    })
    if (!inside) return { ok: false, error: '项目文件夹超出注册根（拒绝）' }
    return { ok: true, folder: abs }
  }

  const taskPathOf = (folder: string): string => joinPath(folder, 'TASK.md')

  reg('exact', '/api/deck/roots', (_req, res) => {
    const out: Record<string, string> = {}
    for (const a of roots.aliases()) out[a] = roots.resolveRoot(a)!
    sendJson(res, 200, { ok: true, roots: out })
  })

  const readCards = (folder: string): TaskCard[] => {
    const raw = taskFs.read(taskPathOf(folder))
    return raw === null ? [] : parseTaskDoc(raw)
  }

  reg('exact', '/api/deck/tasks', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 64 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      // 无 project → 聚合全部（统一看板用）
      const pid = (body as Record<string, unknown>).project
      if (pid === undefined) {
        const boards = store.get().projects.map((p) => {
          const f = projectFolder(p.id)
          return { id: p.id, name: p.name, icon: p.icon, bindSession: p.bindSession ?? null, cards: f.ok ? readCards(f.folder) : [] }
        })
        sendJson(res, 200, { ok: true, boards })
        return
      }
      const f = projectFolder(String(pid))
      if (!f.ok) { sendJson(res, 400, { ok: false, error: f.error }); return }
      sendJson(res, 200, { ok: true, cards: readCards(f.folder) })
    })()
  })

  reg('exact', '/api/deck/task/create', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 64 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      const { project, title, type, body: taskBody } = body as Record<string, unknown>
      const acceptanceRaw = (body as Record<string, unknown>).acceptance
      const f = projectFolder(String(project ?? ''))
      if (!f.ok) { sendJson(res, 400, { ok: false, error: f.error }); return }
      if (typeof title !== 'string' || title.trim() === '' || title.length > 120) { sendJson(res, 400, { ok: false, error: 'title 必填（≤120 字符）' }); return }
      const t: TaskType = typeof type === 'string' && (TASK_TYPES as readonly string[]).includes(type) ? type as TaskType : 'research'
      if (acceptanceRaw !== undefined && !Array.isArray(acceptanceRaw)) { sendJson(res, 400, { ok: false, error: 'acceptance 必须是字符串数组' }); return }
      if (taskBody !== undefined && (typeof taskBody !== 'string' || taskBody.length > 8192)) { sendJson(res, 400, { ok: false, error: 'body 过长（≤8KB）' }); return }
      try {
        const path = taskPathOf(f.folder)
        const existing = taskFs.read(path) ?? ''
        const card = makeCard({
          id: newTaskId(new Date(), readCards(f.folder).map((c) => c.id)),
          title, type: t,
          acceptance: Array.isArray(acceptanceRaw) ? acceptanceRaw.map(String) : [],
          body: typeof taskBody === 'string' ? taskBody : '',
        }, new Date())
        taskFs.write(path, upsertCard(existing, card))
        ensureAgentsMd(taskFs, f.folder)
        sendJson(res, 200, { ok: true, card })
      } catch (e) { sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }) }
    })()
  })

  reg('exact', '/api/deck/task/status', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 16 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      const { project, id, status } = body as Record<string, unknown>
      const f = projectFolder(String(project ?? ''))
      if (!f.ok) { sendJson(res, 400, { ok: false, error: f.error }); return }
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) { sendJson(res, 400, { ok: false, error: 'id 非法' }); return }
      if (typeof status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(status)) { sendJson(res, 400, { ok: false, error: `status 必须是 ${TASK_STATUSES.join('|')}` }); return }
      const raw = taskFs.read(taskPathOf(f.folder))
      if (raw === null) { sendJson(res, 404, { ok: false, error: 'TASK.md 不存在' }); return }
      const next = setCardStatus(raw, id, status as TaskStatus)
      if (next === null) { sendJson(res, 404, { ok: false, error: `任务卡不存在：${id}` }); return }
      taskFs.write(taskPathOf(f.folder), next)
      sendJson(res, 200, { ok: true })
    })()
  })

  reg('exact', '/api/deck/task/dispatch', async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req, 16 * 1024)
    if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
    const f = projectFolder(String((body as Record<string, unknown>).project ?? ''))
    if (!f.ok) { sendJson(res, 400, { ok: false, error: f.error }); return }
    ensureAgentsMd(taskFs, f.folder)
    sendJson(res, 200, await launchZcode(f.folder))
  })

  /** 起终端跑 zcode；失败降级为返回可复制命令。 */
  async function launchZcode(folder: string): Promise<{ ok: boolean, mode: string, command: string, folder: string }> {
    const zcodeCli = resolve(config?.zcodeCli ?? ZCODE_CLI_DEFAULT)
    const zcmd = `"${process.execPath}" "${zcodeCli}"`
    const command = `cd /d "${folder}" && ${zcmd}`
    let mode = 'clipboard'
    if (process.platform === 'win32') {
      try {
        const line = `start "dsh-deck zcode" /D "${folder}" cmd /K ${zcmd}`
        const t0 = Date.now()
        const child = spawn('cmd.exe', ['/d', '/s', '/c', line], { detached: true, stdio: 'ignore' })
        child.on('error', (e) => { ctx.logger.warn(`dsh-deck dispatch child error: ${e.message}`) })
        child.unref()
        ctx.logger.info(`dsh-deck dispatch spawned in ${Date.now() - t0}ms`)
        mode = 'terminal'
      } catch (e) { ctx.logger.warn(`dsh-deck dispatch spawn threw: ${e instanceof Error ? e.message : String(e)}`) }
    }
    return { ok: true, mode, command, folder }
  }

  // ── D4：自媒体台内容层 ──
  const contentFs: ContentFs = {
    list: (dir) => { try { return readdirSync(dir).slice(0, 500) } catch { return [] } },
    isDir: (p) => { try { return statSync(p).isDirectory() } catch { return false } },
    read: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
    write: (p, c) => { mkdirSync(dirnameOf(p), { recursive: true }); const t = p + '.tmp'; writeFileSync(t, c, 'utf8'); renameSync(t, p) },
    mkdirs: (p) => { mkdirSync(p, { recursive: true }) },
    exists: (p) => existsSync(p),
  }

  reg('exact', '/api/deck/content/list', (req, res) => {
    if (!guard(req, res)) return
    try { sendJson(res, 200, { ok: true, items: listContent(contentFs, contentRoot) }) }
    catch (e) { sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }) }
  })

  reg('exact', '/api/deck/content/create', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 64 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      const { title, platforms } = body as Record<string, unknown>
      const type = body !== null && (CONTENT_TYPES as readonly string[]).includes(String((body as Record<string, unknown>).type)) ? String((body as Record<string, unknown>).type) as ContentType : 'article'
      if (typeof title !== 'string' || title.trim() === '' || title.length > 120) { sendJson(res, 400, { ok: false, error: 'title 必填（≤120 字符）' }); return }
      try {
        const item = createContent(contentFs, contentRoot, { title, type, platforms: typeof platforms === 'string' ? platforms.slice(0, 120) : '' }, new Date())
        sendJson(res, 200, { ok: true, item })
      } catch (e) { sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }) }
    })()
  })

  reg('exact', '/api/deck/content/status', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 16 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      const { slug, status } = body as Record<string, unknown>
      if (typeof slug !== 'string' || !(CONTENT_STATUSES as readonly string[]).includes(String(status))) {
        sendJson(res, 400, { ok: false, error: `status 必须是 ${CONTENT_STATUSES.join('|')}` }); return
      }
      const item = setContentStatus(contentFs, contentRoot, slug, status as ContentStatus)
      if (item === null) { sendJson(res, 404, { ok: false, error: `内容项不存在：${slug}` }); return }
      sendJson(res, 200, { ok: true, item })
    })()
  })

  /** 内容项交给 zcode：建任务卡（含类型验收）+ 起终端。 */
  reg('exact', '/api/deck/content/handoff', async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req, 16 * 1024)
    if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
    const slug = String((body as Record<string, unknown>).slug ?? '')
    const items = listContent(contentFs, contentRoot)
    const item = items.find((i) => i.slug === slug)
    if (item === undefined) { sendJson(res, 404, { ok: false, error: `内容项不存在：${slug}` }); return }
    try {
      const taskPath = taskPathOf(contentRoot)
      const card = makeCard({
        id: newTaskId(new Date(), parseTaskDoc(taskFs.read(taskPath) ?? '').map((c) => c.id)),
        title: `${item.type === 'ppt' ? 'PPT' : item.type === 'video' ? '视频' : '文章'}：${item.title}`,
        type: item.type as TaskType,
        acceptance: ACCEPTANCE_BY_TYPE[item.type],
        body: `工作目录：content/${item.slug}/（读 选题.md 与模板文件，产物写在同目录）。完成后把 meta.md 的 status 改成 ready，任务卡改 review。`,
      }, new Date())
      taskFs.write(taskPath, upsertCard(taskFs.read(taskPath) ?? '', card))
      ensureAgentsMd(taskFs, contentRoot)
      const launch = await launchZcode(contentRoot)
      sendJson(res, 200, { ok: true, card, ...launch })
    } catch (e) { sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }) }
  })

  // ── D5：发布预填（意图链预填 + 剪贴板兜底，永远人工点发）+ 记录回写 ──
  const findItem = (slug: unknown): { item: ReturnType<typeof listContent>[number] } | { item: undefined } => {
    const it = listContent(contentFs, contentRoot).find((i) => i.slug === slug)
    return { item: it }
  }

  reg('exact', '/api/deck/publish/prefill', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 16 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      const { slug, platform } = body as Record<string, unknown>
      const target = PREFILL_TARGETS[String(platform ?? '')]
      const { item } = findItem(slug)
      if (target === undefined) { sendJson(res, 400, { ok: false, error: `platform 必须是 ${Object.keys(PREFILL_TARGETS).join('|')}` }); return }
      if (item === undefined) { sendJson(res, 404, { ok: false, error: `内容项不存在：${String(slug)}` }); return }
      const text = buildPrefillText(contentFs, contentRoot, item, target.limit)
      appendPublishRow(contentFs, contentRoot, item.slug, { date: new Date().toISOString().slice(0, 10), platform: target.name, result: '预填（未发）', note: '意图链预填，人工点发' })
      if (item.status === 'idea' || item.status === 'drafting') setContentStatus(contentFs, contentRoot, item.slug, 'prefill')
      sendJson(res, 200, { ok: true, url: target.intent(text), text, platform: target.name })
    })()
  })

  reg('exact', '/api/deck/publish/record', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 16 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      const { slug, platform, link } = body as Record<string, unknown>
      const target = PREFILL_TARGETS[String(platform ?? '')]
      const { item } = findItem(slug)
      if (target === undefined || item === undefined) { sendJson(res, 400, { ok: false, error: 'slug/platform 非法' }); return }
      const linkSafe = typeof link === 'string' ? link.replace(/[|\n\r]/g, ' ').slice(0, 200) : ''
      appendPublishRow(contentFs, contentRoot, item.slug, { date: new Date().toISOString().slice(0, 10), platform: target.name, result: '已发布 ' + linkSafe, note: '人工点发' })
      setContentStatus(contentFs, contentRoot, item.slug, 'published')
      sendJson(res, 200, { ok: true })
    })()
  })

  // ── D3下：审阅（读 RESULT/widget）+ 落库执行器（唯一写 LESSONS.md 的通道）──
  const resultFilesOf = (folder: string) => ({
    result: taskFs.read(joinPath(folder, 'RESULT.md')),
    widget: taskFs.read(joinPath(folder, 'widget-result.json')),
  })

  reg('exact', '/api/deck/review/result', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 16 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      const f = projectFolder(String((body as Record<string, unknown>).project ?? ''))
      if (!f.ok) { sendJson(res, 400, { ok: false, error: f.error }); return }
      const files = resultFilesOf(f.folder)
      if (files.result === null) { sendJson(res, 404, { ok: false, error: 'RESULT.md 不存在（zcode 还没交活或没按协议写）' }); return }
      const parsed = parseResultDoc(files.result)
      sendJson(res, 200, { ok: true, result: parsed, widget: parseWidgetJson(files.widget) })
    })()
  })

  reg('exact', '/api/deck/review/approve', async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req, 64 * 1024)
    if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
    const { project, id, picks } = body as Record<string, unknown>
    const f = projectFolder(String(project ?? ''))
    if (!f.ok) { sendJson(res, 400, { ok: false, error: f.error }); return }
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) { sendJson(res, 400, { ok: false, error: 'id 非法' }); return }
    if (!Array.isArray(picks) || picks.length === 0 || picks.length > 50 || !picks.every((n) => Number.isInteger(n) && n >= 0)) {
      sendJson(res, 400, { ok: false, error: 'picks 必须是非空判断下标数组' }); return
    }
    const files = resultFilesOf(f.folder)
    if (files.result === null) { sendJson(res, 404, { ok: false, error: 'RESULT.md 不存在' }); return }
    const parsed = parseResultDoc(files.result)
    const maxIdx = parsed.judgments.length - 1
    const picked = [...new Set(picks as number[])].sort((a, b) => a - b)
    if (picked.some((n) => n > maxIdx)) { sendJson(res, 400, { ok: false, error: `picks 越界（0..${maxIdx}）` }); return }
    const cards = readCards(f.folder)
    const card = cards.find((c) => c.id === id)
    if (card === undefined) { sendJson(res, 404, { ok: false, error: `任务卡不存在：${id}` }); return }
    try {
      const lessonsPath = joinPath(kbRoot, 'insights', 'LESSONS.md')
      const lessons = taskFs.read(lessonsPath) ?? ''
      const date = new Date().toISOString().slice(0, 10)
      const section = buildLessonsSection(lessons, picked.map((n) => parsed.judgments[n]!), { taskId: card.id, taskTitle: card.title, date })
      taskFs.write(lessonsPath, lessons + section)
      // 任务卡 → done
      const taskPath = taskPathOf(f.folder)
      const next = setCardStatus(taskFs.read(taskPath) ?? '', card.id, 'done')
      if (next !== null) taskFs.write(taskPath, next)
      // 知识库 git 提交（失败不阻断落库，仅回报）
      let gitMsg = ''
      await new Promise<void>((done) => {
        execFile('git', ['add', 'insights/LESSONS.md'], { cwd: kbRoot, windowsHide: true }, () => {
          execFile('git', ['commit', '-m', `deck: 判断落库 ${card.id}（${picked.length} 条）`, '--no-verify'], { cwd: kbRoot, windowsHide: true }, (err, _so, se) => {
            gitMsg = err === null ? '已 git 提交' : `git 提交失败（${String(se).slice(0, 120)}）`
            done()
          })
        })
      })
      sendJson(res, 200, { ok: true, count: picked.length, section: section.trimStart().split('\n')[0] ?? '', git: gitMsg })
    } catch (e) { sendJson(res, 500, { ok: false, error: `落库失败：${e instanceof Error ? e.message : String(e)}` }) }
  })

  const fsRoute = (op: 'list' | 'read' | 'write' | 'mkdir') => (req: any, res: any): void => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 16 * 1024 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      const { root: alias, path: rel } = body as { root?: string; path?: string }
      const rootAbs = typeof alias === 'string' ? roots.resolveRoot(alias) : undefined
      if (rootAbs === undefined) { sendJson(res, 400, { ok: false, error: `root 必须是 ${roots.aliases().join('|')}` }); return }
      if (op === 'list') {
        const dirAbs = rel === '' || rel === undefined ? rootAbs : resolveWithinRoot(rootAbs, String(rel))
        if (dirAbs === null) { sendJson(res, 400, { ok: false, error: 'path 非法（穿越/绝对路径被拒）' }); return }
        try {
          const entries = readdirSync(dirAbs, { withFileTypes: true })
            .slice(0, 500)
            .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
          sendJson(res, 200, { ok: true, entries })
        } catch (e) { sendJson(res, 400, { ok: false, error: `list 失败：${e instanceof Error ? e.message : String(e)}` }) }
        return
      }
      const abs = resolveWithinRoot(rootAbs, String(rel ?? ''))
      if (abs === null) { sendJson(res, 400, { ok: false, error: 'path 非法（穿越/绝对路径被拒）' }); return }
      if (op === 'read') {
        try {
          const stat = statSync(abs)
          if (stat.size > 20 * 1024 * 1024) { sendJson(res, 400, { ok: false, error: '文件超过 20MB' }); return }
          sendJson(res, 200, { ok: true, content: readFileSync(abs, 'utf8'), size: stat.size })
        } catch (e) { sendJson(res, 400, { ok: false, error: `read 失败：${e instanceof Error ? e.message : String(e)}` }) }
        return
      }
      if (op === 'write') {
        const content = (body as Record<string, unknown>).content
        if (typeof content !== 'string' || content.length > 20 * 1024 * 1024) { sendJson(res, 400, { ok: false, error: 'content 必须是 ≤20MB 字符串' }); return }
        try {
          mkdirSync(dirnameOf(abs), { recursive: true })
          const tmp = abs + '.tmp'
          writeFileSync(tmp, content, 'utf8')
          renameSync(tmp, abs)
          sendJson(res, 200, { ok: true })
        } catch (e) { sendJson(res, 400, { ok: false, error: `write 失败：${e instanceof Error ? e.message : String(e)}` }) }
        return
      }
      // mkdir
      try { mkdirSync(abs, { recursive: true }); sendJson(res, 200, { ok: true }) }
      catch (e) { sendJson(res, 400, { ok: false, error: `mkdir 失败：${e instanceof Error ? e.message : String(e)}` }) }
    })()
  }
  reg('exact', '/api/deck/fs/list', fsRoute('list'))
  reg('exact', '/api/deck/fs/read', fsRoute('read'))
  reg('exact', '/api/deck/fs/write', fsRoute('write'))
  reg('exact', '/api/deck/fs/mkdir', fsRoute('mkdir'))

  // ── 知识库：FTS 搜索（懒建索引 + 5 分钟 TTL 增量）──
  const ideasDir = joinPath(kbRoot, 'ideas')
  const index = new KbIndex(joinPath(dshHome, 'storages', 'dsh-deck-fts.db'), kbRoot, nodeWalk(kbRoot))
  let lastIndexAt = 0
  const ensureIndex = (): void => {
    if (Date.now() - lastIndexAt < 5 * 60 * 1000) return
    lastIndexAt = Date.now()
    setImmediate(() => { try { index.sync() } catch (e) { ctx.logger.warn(`dsh-deck fts sync: ${e instanceof Error ? e.message : String(e)}`) } })
  }

  reg('exact', '/api/deck/search', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 64 * 1024)
      const q = body !== null && typeof body === 'object' ? String((body as Record<string, unknown>).q ?? '') : ''
      if (q.trim() === '') { sendJson(res, 200, { ok: true, results: [], tookMs: 0 }); return }
      try {
        ensureIndex()
        const t0 = Date.now()
        // 首查可能索引未建：同步补一次（首建全量约 2.4s，之后毫秒级）
        if (index.count() === 0) index.sync()
        const results = index.query(q, 20)
        sendJson(res, 200, { ok: true, results, tookMs: Date.now() - t0, indexed: index.count() })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `搜索失败：${e instanceof Error ? e.message : String(e)}` })
      }
    })()
  })

  const fileRoute = (path: (kbRoot: string) => string) => (req: any, res: any): void => {
    if (!guard(req, res)) return
    try {
      const abs = path(kbRoot)
      const content = readFileSync(abs, 'utf8')
      sendJson(res, 200, { ok: true, content })
    } catch (e) {
      sendJson(res, 404, { ok: false, error: `读取失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }
  reg('exact', '/api/deck/kb/index', fileRoute((r) => joinPath(r, 'INDEX.md')))
  reg('exact', '/api/deck/insights', fileRoute((r) => joinPath(r, 'insights', 'LESSONS.md')))

  // ── 点子库 ──
  const ideasFs: IdeasFs = {
    list: (dir) => { try { return readdirSync(dir).filter((n) => n.endsWith('.md')) } catch { return [] } },
    read: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
    write: (p, c) => { mkdirSync(dirnameOf(p), { recursive: true }); writeFileSync(p, c, 'utf8') },
    exists: (p) => { try { statSync(p); return true } catch { return false } },
    mkdirs: (p) => { mkdirSync(p, { recursive: true }) },
  }
  reg('exact', '/api/deck/ideas', (req, res) => {
    if (!guard(req, res)) return
    try { sendJson(res, 200, { ok: true, ideas: listIdeas(ideasFs, ideasDir) }) }
    catch (e) { sendJson(res, 500, { ok: false, error: String(e) }) }
  })
  reg('exact', '/api/deck/idea/capture', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 64 * 1024)
      const text = body !== null && typeof body === 'object' ? String((body as Record<string, unknown>).text ?? '') : ''
      try { const file = captureIdea(ideasFs, ideasDir, text, new Date()); sendJson(res, 200, { ok: true, file }) }
      catch (e) { sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }) }
    })()
  })
  reg('exact', '/api/deck/idea/adopt', (req, res) => {
    if (!guard(req, res)) return
    void (async () => {
      const body = await readJsonBody(req, 64 * 1024)
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'body 非法' }); return }
      const { file, to } = body as { file?: string; to?: string }
      if (typeof file !== 'string' || !file.endsWith('.md') || file.includes('/') || file.includes('\\') || file.includes('..')) {
        sendJson(res, 400, { ok: false, error: 'file 非法' }); return
      }
      if (to !== 'research' && to !== 'content') { sendJson(res, 400, { ok: false, error: 'to 必须是 research|content' }); return }
      try {
        const r = adoptIdea(ideasFs, ideasDir, file, to, kbRoot, contentRoot)
        sendJson(res, 200, r)
      } catch (e) { sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }) }
    })()
  })
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i <= 0 ? '.' : p.slice(0, i)
}
