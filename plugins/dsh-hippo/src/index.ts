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
import { readTeamEvents, distillTeamEvents, foldLedger, triage } from './hippo/engine.js'
import {
  loadAutoSettings, saveAutoSettings, listShelved, takeShelved,
  runAutoDistillOnce, withEngine, distill, deleteSession, type AutoDistillSettings,
} from './hippo/engine.js'
import { compileMemories, forgetMemory, listMemories, updateMemory } from './memories.ts'
import { registerPromptContext, registerRecallTool, registerRememberTool } from './tools.ts'
import { registerLifeTools } from './life-tools.ts'
import { startAutonomyLoop } from './life-autonomy.ts'
import type { DoctorReport } from './types.ts'

/** H4 回写开关：默认关，cordis.patch.yml / profile config 里 writeback: true 显式开启。 */
export interface Config {
  writeback: boolean
}

export const name = 'dsh-hippo'

/**
 * 引擎源码已并入本包（原 hippo-mind 独立包已合并）：原生/平台依赖是本包的
 * 直接 dependencies，从插件自身位置解析即可——旧的"以引擎安装位置为锚点"
 * 的探测 hack 随包合并一并移除。
 */
const selfRequire = createRequire(import.meta.url)

/** 加载一个原生依赖，返回 null（成功）或错误信息。 */
function tryNativeLoad(spec: string): string | null {
  try {
    selfRequire(spec)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const NATIVE_BLOCKED_HINT =
  '会话索引模块 better-sqlite3 加载失败（迁移与会话搜索不可用）。pnpm 10 / npm 12 默认拦截依赖 install 脚本导致 prebuild 二进制缺失时：在插件安装目录执行 pnpm approve-builds 勾选（或在其 pnpm-workspace.yaml 的 onlyBuiltDependencies 加入）后重装。'

/** 自检：存储栈 / 记忆库探测，产出放行/下载指引。 */
async function doctor(): Promise<DoctorReport> {
  const guidance: string[] = []

  // 引擎源码已内联进插件 bundle——doctor 能跑到这里引擎就已加载成功；
  // 真正会失败的是外置原生模块（安装期 pnpm 拦截 build script 的场景）。
  // 存储分工：记忆本体在 @zvec/zvec（proxima 向量 + rocksdb FTS）；
  // better-sqlite3 服务会话索引 sessions.db（FTS5 trigram 中文搜索）与
  // zcode 数据源只读——迁移链路两者都需要。
  const zvecErr = tryNativeLoad('@zvec/zvec')
  const sqliteErr = tryNativeLoad('better-sqlite3')

  if (zvecErr !== null) guidance.push(`当前存储栈 @zvec/zvec 加载失败：${zvecErr}。请在插件目录重装依赖（pnpm install）。`)
  if (sqliteErr !== null) guidance.push(NATIVE_BLOCKED_HINT)

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

  // 生活流（居民）依赖 ollama 本地 API——summon/relay/task/K3 全走它。
  // 探测可达性 + 已拉取的模型列表，不可达时给出指引（否则居民只会"生成失败"）。
  let ollamaOk = true
  let ollamaDetail = ''
  try {
    const resp = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    if (resp.ok) {
      const tags = (await resp.json()) as { models?: Array<{ name?: string }> }
      const names = (tags.models ?? []).map((m) => m.name ?? '').filter(Boolean)
      ollamaDetail = names.length > 0 ? `可达，模型：${names.slice(0, 5).join('、')}` : '可达，但还没有拉取任何模型（ollama pull <model>）'
      if (names.length === 0) ollamaOk = false
    } else {
      ollamaOk = false
      ollamaDetail = `ollama 响应异常：HTTP ${resp.status}`
    }
  } catch {
    ollamaOk = false
    ollamaDetail = '无法连接 127.0.0.1:11434（ollama 未启动？）'
  }
  if (!ollamaOk) {
    guidance.push('生活流居民需要 ollama 本地服务（127.0.0.1:11434）生成回复。请安装并启动 ollama，拉取居民用的模型（默认 gemma4:e4b，可在 ~/.dsh/settings.yaml 的 llm-pi-ai 节配置）。')
  }

  const checks = [
    { name: '记忆引擎（内置）', ok: true, detail: '已内联进插件 bundle' },
    { name: '向量存储 @zvec/zvec', ok: zvecErr === null, detail: zvecErr ?? 'proxima 索引 + rocksdb FTS 就绪' },
    { name: '会话索引 better-sqlite3', ok: sqliteErr === null, detail: sqliteErr ?? 'sessions.db FTS5 就绪（迁移/会话搜索用）' },
    { name: '记忆库', ok: true, detail: storeExists === true ? storePath : storeExists === false ? `尚未创建（首次 import/recall 时自动建立）：${storePath}` : `无法探测：${storePath}` },
    { name: 'ollama 生活流引擎', ok: ollamaOk, detail: ollamaDetail },
  ]

  return {
    ok: zvecErr === null && sqliteErr === null && ollamaOk,
    // 迁移链路只依赖引擎三件套；ollama 挂了不该挡住"开始迁移"（生活流专属依赖）
    migrationReady: zvecErr === null && sqliteErr === null,
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


export function apply(ctx: Context, config?: Config): void {
  ctx.logger.info('dsh-hippo: 记忆桥已加载（H2 工具+提示注入 / H3 管理+编译 / H4 回写' + (config?.writeback === true ? '已开启' : '默认关') + '）')

  // H2：memory_recall 工具 + systemPrompt 注入（服务缺席时降级跳过，不阻断插件）。
  ctx.inject(['tools', 'agents', 'sandboxPolicy'], (tc) => {
    registerRecallTool(tc)
    if (config?.writeback === true) registerRememberTool(tc)
  })
  ctx.inject(['tools', 'agents', 'sandboxPolicy', 'llm'], (tc) => {
    registerLifeTools(tc)
  })
  // K3：主动行为循环（dsh web 常驻时活跃——chattiness 参数控频）
  ctx.inject(['llm'], (lc) => {
    return startAutonomyLoop(lc as never)
  })
  ctx.inject(['systemPrompt', 'agents', 'sandboxPolicy'], (pc) => {
    registerPromptContext(pc)
  })

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = [
        // T0：dump 本机全部团队事件（rc.8 起有真实数据；rc.7 返回 0 条属预期）
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-team-memory/dump',
          handler: (_request, response) => {
            sendJson(response, 200, readTeamEvents())
          },
        }),
        // T1：扫描蒸馏（events → L1 私有 + L2 晋升 → 账本）
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-team-memory/scan',
          handler: (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '仅接受同源请求' })
              return
            }
            void readJsonBody(request).then(
              async (body) => {
                try {
                  const dump = readTeamEvents()
                  if (dump.events.length === 0) {
                    sendJson(response, 200, { note: '本机无团队事件（需 harness rc.8+ 并跑过 agent team）；fixture 驱动的管线验证见测试', report: null })
                    return
                  }
                  void body
                  const byTeam = new Map<string, typeof dump.events>()
                  for (const ev of dump.events) {
                    const list = byTeam.get(ev.teamId) ?? []
                    list.push(ev)
                    byTeam.set(ev.teamId, list)
                  }
                  const reports = []
                  for (const [teamId, events] of byTeam) {
                    reports.push(await distillTeamEvents(events, { apply: true }))
                    void teamId
                  }
                  sendJson(response, 200, { teams: byTeam.size, reports })
                } catch (error) {
                  sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
                }
              },
              (error: unknown) => { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        // 账本当前视图 + 审计退役记录
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-team-memory/entries',
          handler: (_request, response) => {
            sendJson(response, 200, foldLedger())
          },
        }),

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
          path: '/dsh-hippo/memories',
          handler: (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            const url = new URL(request.url ?? '/dsh-hippo/memories', 'http://localhost')
            void listMemories({
              q: url.searchParams.get('q') ?? undefined,
              type: url.searchParams.get('type') ?? undefined,
              project: url.searchParams.get('project') ?? undefined,
              offset: Number(url.searchParams.get('offset') ?? '0') || 0,
              limit: Number(url.searchParams.get('limit') ?? '30') || 30,
            }).then(
              (page) => { sendJson(response, 200, page) },
              (error: unknown) => { sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/memories/forget',
          handler: (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '仅接受同源请求' })
              return
            }
            void readJsonBody(request).then(
              (body) => {
                const id = typeof body.id === 'string' ? body.id : ''
                void forgetMemory(id).then(
                  (r) => { sendJson(response, 200, r) },
                  (error: unknown) => { sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }) },
                )
              },
              (error: unknown) => { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/memories/update',
          handler: (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '仅接受同源请求' })
              return
            }
            void readJsonBody(request).then(
              (body) => {
                const id = typeof body.id === 'string' ? body.id : ''
                const fields: { text?: string; type?: string; project?: string } = {}
                if (typeof body.text === 'string') fields.text = body.text
                if (typeof body.type === 'string') fields.type = body.type
                if (typeof body.project === 'string') fields.project = body.project
                void updateMemory(id, fields).then(
                  (r) => { sendJson(response, 200, r) },
                  (error: unknown) => { sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }) },
                )
              },
              (error: unknown) => { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/memories/compile',
          handler: (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '仅接受同源请求' })
              return
            }
            void readJsonBody(request).then(
              (body) => compileMemories({
                project: typeof body.project === 'string' && body.project.trim() !== '' ? body.project.trim() : undefined,
                write: body.write === true,
                outPath: typeof body.outPath === 'string' ? body.outPath : undefined,
              }).then(
                (outcome) => { sendJson(response, 200, outcome) },
                (error: unknown) => { sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }) },
              ),
              (error: unknown) => { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/auto',
          handler: (request, response) => {
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '仅接受同源请求' })
              return
            }
            if (request.method === 'GET') {
              try {
                sendJson(response, 200, { settings: loadAutoSettings(), shelvedCount: listShelved().length })
              } catch (e) {
                sendJson(response, 500, { error: e instanceof Error ? e.message : String(e) })
              }
              return
            }
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'GET, POST' })
              response.end()
              return
            }
            void readJsonBody(request).then(
              (body) => {
                try {
                  const merged: AutoDistillSettings = { ...loadAutoSettings(), ...(body.settings as object ?? {}) }
                  saveAutoSettings(merged)
                  sendJson(response, 200, { settings: merged })
                } catch (e) {
                  sendJson(response, 500, { error: e instanceof Error ? e.message : String(e) })
                }
              },
              (error: unknown) => { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/auto/run',
          handler: (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '仅接受同源请求' })
              return
            }
            void runAutoDistillOnce().then(
              (stats) => sendJson(response, 200, stats),
              (error: unknown) => { sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/shelved',
          handler: (request, response) => {
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '仅接受同源请求' })
              return
            }
            if (request.method === 'GET') {
              try {
                sendJson(response, 200, listShelved().map((x, i) => ({ index: i, reason: x.reason, project: x.candidate.project, type: x.candidate.type, confidence: x.candidate.confidence, text: x.candidate.text })))
              } catch (e) {
                sendJson(response, 500, { error: e instanceof Error ? e.message : String(e) })
              }
              return
            }
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'GET, POST' })
              response.end()
              return
            }
            void readJsonBody(request).then(
              (body) => {
                const indices = Array.isArray(body.indices) ? body.indices.map(Number).filter(Number.isInteger) : []
                if (body.action === 'discard') {
                  takeShelved(indices)
                  sendJson(response, 200, { remaining: listShelved().length })
                  return
                }
                // apply：引擎短持走 withEngine + distill（与 GUI 同一管线）
                void withEngine(async (held) => {
                  const all = listShelved()
                  const cands = indices.filter((i) => all[i] !== undefined).map((i) => ({ ...all[i].candidate }))
                  if (cands.length === 0) { sendJson(response, 404, { error: 'no such items' }); return }
                  const r = await distill(held.engine, cands, { apply: true, agent: 'dsh:review' })
                  takeShelved(indices)
                  sendJson(response, 200, { created: r.created, reinforced: r.reinforced, skipped: r.skipped, maybe: r.maybe })
                }).catch((error: unknown) => {
                  sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
                })
              },
              (error: unknown) => { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/memories/supersede',
          handler: (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '仅接受同源请求' })
              return
            }
            void readJsonBody(request).then(
              (body) => {
                void withEngine(async (held) => {
                  const ok = await held.engine.markSuperseded(String(body.oldId), String(body.newId))
                  sendJson(response, 200, { ok })
                }).catch((error: unknown) => {
                  sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
                })
              },
              (error: unknown) => { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/sleep',
          handler: (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '仅接受同源请求' })
              return
            }
            void readJsonBody(request).then(
              (body) => {
                void withEngine(async (held) => {
                  const { runSleep } = await import('./hippo/engine.js')
                  const r = await runSleep(held.engine, { apply: body.apply === true })
                  sendJson(response, 200, r)
                }).catch((error: unknown) => {
                  sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
                })
              },
              (error: unknown) => { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) },
            )
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-hippo/sessions/delete',
          handler: (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
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
                  const { deleteSession } = require('./hippo/engine.js') as typeof import('./hippo/engine.js')
                  const r = deleteSession(String(body.id), { deleteSource: body.deleteSource === true })
                  sendJson(response, 200, r)
                } catch (e) {
                  sendJson(response, 500, { error: e instanceof Error ? e.message : String(e) })
                }
              },
              (error: unknown) => { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) },
            )
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
