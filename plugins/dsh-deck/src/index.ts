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
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DeckStore, deckDefaults, deckPath, nodeFs } from './state.ts'
import { allowRequest, readJsonBody, resolveWithinRoot, RootRegistry, type RequestLike } from './security.ts'
import { createProject, deleteProject, updateProject, type DeckState, type ProjectInput } from './protocol.ts'
import z from 'schemastery'

export const name = 'dsh-deck'
export const inject = ['webServer']

const KB_ROOT_DEFAULT = 'D:/coding/knowledge-base'
const CONTENT_ROOT_DEFAULT = 'D:/coding/content'

export interface Config {
  kbRoot: string
  contentRoot: string
}

export const Config = z.object({
  kbRoot: z.string().default(KB_ROOT_DEFAULT),
  contentRoot: z.string().default(CONTENT_ROOT_DEFAULT),
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
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i <= 0 ? '.' : p.slice(0, i)
}
