/**
 * dsh-deck 安全层（纯函数，零宿主依赖，可单测）。
 * 威胁模型：其他网页标签页对 127.0.0.1:3080 发起的跨站请求（CSRF/跨站读）。
 * 规则：
 *  - 写方法（POST/PUT/DELETE）：Origin 头必须存在且与请求自身 host 同源；
 *    无 Origin 的写一律拒绝（浏览器跨站 POST 必带 Origin，缺失=非浏览器或异常）。
 *  - 读方法（GET/HEAD）：带 Origin 时必须同源（挡跨站读）；不带放行（导航/addr 栏）。
 *  - 路径安全：客户端永远只传 POSIX 相对路径；拒绝绝对路径、.. 段、反斜杠、
 *    盘符、NUL；再以 path.resolve 包含性复核（纵深防御）。
 * @module dsh-deck/security
 */
import { resolve, sep } from 'node:path'

export interface RequestLike {
  method?: string | undefined
  headers?: Record<string, string | string[] | undefined> | undefined
}

function header(req: RequestLike, name: string): string {
  const v = req.headers?.[name]
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

function sameOrigin(origin: string, host: string): boolean {
  try {
    const u = new URL(origin)
    return u.host === host
  } catch {
    return false
  }
}

/** 源校验：写方法强制同源 Origin；读方法带 Origin 时必须同源。 */
export function allowRequest(req: RequestLike): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  const origin = header(req, 'origin')
  const host = header(req, 'host')
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    if (origin === '') return true
    return sameOrigin(origin, host)
  }
  if (origin === '' || host === '') return false
  return sameOrigin(origin, host)
}

export type RootAlias = string

export class RootRegistry {
  private readonly map = new Map<RootAlias, string>()

  register(alias: string, absPath: string): void {
    this.map.set(alias, resolve(absPath))
  }

  get(alias: string): string | undefined {
    return this.map.get(alias)
  }

  aliases(): string[] {
    return [...this.map.keys()]
  }

  /** 根别名 → 绝对根路径；未注册别名拒绝。 */
  resolveRoot(alias: string): string | undefined {
    return this.map.get(alias)
  }
}

/**
 * 相对路径安全解析：POSIX 相对、无 .. 段、无反斜杠/盘符/NUL，resolve 后必须
 * 仍落在根内。点开头的段（.git/.gitignore 等）合法——穿越由段级检查+包含性
 * 复核负责，不靠前缀一刀切。
 */
export function resolveWithinRoot(rootAbs: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) return null
  if (rel.includes('\0')) return null
  if (rel.includes('\\')) return null
  if (rel.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(rel)) return null
  const segments = rel.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null
  const root = resolve(rootAbs)
  const abs = resolve(root, ...segments)
  const normAbs = abs.split(sep).join('/')
  const normRoot = root.split(sep).join('/')
  if (normAbs !== normRoot && !normAbs.startsWith(normRoot + '/')) return null
  return abs
}

/** 读取请求 JSON body（带大小上限，防巨型 payload）。 */
export async function readJsonBody(req: { on: (ev: string, cb: (chunk?: Buffer) => void) => void }, limitBytes = 8 * 1024 * 1024): Promise<unknown | null> {
  return await new Promise((resolvePromise) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (v: unknown | null) => {
      if (done) return
      done = true
      resolvePromise(v)
    }
    req.on('data', (chunk?: Buffer) => {
      if (chunk === undefined) return
      size += chunk.length
      if (size > limitBytes) { finish(null); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { finish({}); return }
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { finish(null) }
    })
    req.on('error', () => finish(null))
  })
}
