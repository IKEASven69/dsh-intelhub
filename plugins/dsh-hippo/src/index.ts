/**
 * dsh-hippo host 半：webServer 路由桥（dshmarket 第三方先例）。
 * H0 只提供 GET /dsh-hippo/doctor 自检（引擎可加载？原生模块就绪？存储库在哪？），
 * 失败给出放行/下载指引。H1 起追加 POST /dsh-hippo/import 与 GET stats；
 * H2 起注册 memory_recall 工具。
 * @module dsh-hippo
 */

import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context.webServer merge（宿主由 web bundle 提供，不打进产物）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import { currentJob, inventory, startImport } from './import.ts'
import type { DoctorReport } from './types.ts'

export const name = 'dsh-hippo'

/** 动态加载可选依赖：变量形式的 specifier 不参与静态类型解析，装载失败返回错误信息。 */
async function tryImport(spec: string): Promise<string | null> {
  try {
    await import(spec)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/**
 * 在引擎 hippo-skills 的真实安装位置上构造 require：原生模块是引擎的传递依赖，
 * pnpm 严格布局（或 link: 开发安装）下位于引擎自己的 node_modules，从插件目录
 * 直接解析必然失败——必须以引擎为锚点探测。
 */
function engineScopedRequire(): ((spec: string) => unknown) | null {
  try {
    const enginePkg = createRequire(import.meta.url).resolve('hippo-skills/package.json')
    return createRequire(enginePkg)
  } catch {
    return null
  }
}

/** 用引擎锚点的 require 实际加载一个依赖，返回 null（成功）或错误信息。 */
function tryEngineLoad(req: ((spec: string) => unknown) | null, spec: string): string | null {
  if (req === null) return `无法定位 hippo-skills 的安装位置，跳过 ${spec} 探测`
  try {
    req(spec)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const NATIVE_BLOCKED_HINT =
  'pnpm 10 / npm 12 默认拦截依赖 install 脚本，原生模块的 prebuild 二进制因此未下载。放行方式：在插件安装目录执行 pnpm approve-builds 勾选 better-sqlite3 与 sqlite-vec（或在 pnpm-workspace.yaml 的 onlyBuiltDependencies 中加入两者）后重装。已安装 dsh-depsec 的用户可在其面板用「写回放行清单」一键完成。'

/** 自检：引擎 / 原生模块 / 记忆库三段探测，产出放行/下载指引。 */
async function doctor(): Promise<DoctorReport> {
  const guidance: string[] = []

  const engineErr = await tryImport('hippo-skills')
  const engineReq = engineScopedRequire()
  const sqliteErr = engineErr === null ? tryEngineLoad(engineReq, 'better-sqlite3') : '引擎不可用，无法探测'
  const vecErr = engineErr === null ? tryEngineLoad(engineReq, 'sqlite-vec') : '引擎不可用，无法探测'

  if (engineErr !== null) guidance.push(`引擎包 hippo-skills 加载失败：${engineErr}。请在插件目录重装依赖（pnpm install）。`)
  if (engineErr === null && (sqliteErr !== null || vecErr !== null)) guidance.push(NATIVE_BLOCKED_HINT)

  const dataDir = process.env.HIPPO_DATA_DIR ?? join(homedir(), '.hippo')
  // 引擎 v0.1.9 起 zvec 原生存储在 <dataDir>/memories/（proxima 向量索引 +
  // rocksdb FTS）；根下的 memories.db 是旧版引擎遗留文件，不作判断依据。
  const storePath = join(dataDir, 'memories')
  let storeExists: boolean | null = null
  try {
    storeExists = existsSync(storePath)
  } catch {
    storeExists = null
  }

  const checks = [
    { name: '引擎 hippo-skills', ok: engineErr === null, detail: engineErr ?? 'openEngine() 可用' },
    { name: '原生模块 better-sqlite3', ok: sqliteErr === null, detail: sqliteErr ?? 'prebuild 二进制正常' },
    { name: '原生模块 sqlite-vec', ok: vecErr === null, detail: vecErr ?? '向量扩展正常' },
    { name: '记忆库', ok: true, detail: storeExists === true ? storePath : storeExists === false ? `尚未创建（首次 import/recall 时自动建立）：${storePath}` : `无法探测：${storePath}` },
  ]

  return {
    ok: engineErr === null && sqliteErr === null && vecErr === null,
    checks,
    storePath,
    storeExists,
    modelNote: '首次 distill / recall 会自动下载 bge-m3 嵌入模型（约 2GB；国内网络建议预先配置 HF 镜像，详见 README）。',
    guidance,
  }
}

function sendJson(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** 同源守卫（dshmarket 先例）：带 Origin 的请求必须与 Host 一致，防跨站 POST。 */
function sameOrigin(request: { headers: { origin?: string; host?: string } }): boolean {
  const { origin, host } = request.headers
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 读取 JSON 请求体（上限 4 KiB，超限拒绝）。 */
function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 4096) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        resolve(raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', reject)
  })
}


export function apply(ctx: Context): void {
  ctx.logger.info('dsh-hippo: 记忆桥已加载（H1：doctor + import）')
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = [
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/doctor',
          handler: (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            void doctor().then(
              (report) => { sendJson(response, 200, report) },
              (error: unknown) => { sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/inventory',
          handler: (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            sendJson(response, 200, inventory())
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/import',
          handler: (request, response) => {
            if (request.method === 'GET') {
              sendJson(response, 200, currentJob())
              return
            }
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'GET, POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '仅接受同源请求' })
              return
            }
            void readJsonBody(request).then(
              (body) => {
                try {
                  const job = startImport({ dryRun: body.dryRun === true })
                  sendJson(response, 200, job)
                } catch (e) {
                  sendJson(response, 409, { error: e instanceof Error ? e.message : String(e) })
                }
              },
              (error: unknown) => { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
      ]
      return () => { for (const d of disposers) d() }
    }, 'dsh-hippo: http routes')
  })
}
