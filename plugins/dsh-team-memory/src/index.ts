/**
 * dsh-team-memory host 半（T0/T1）：webServer 路由——事件 dump、扫描蒸馏、
 * 账本视图。T2 起补设置面板与退役审批门。
 * @module dsh-team-memory
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context.webServer merge（宿主由 web bundle 提供，不打进产物）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ServerResponse, IncomingMessage } from 'node:http'
import { readTeamEvents, distillTeamEvents, foldLedger, triage } from 'hippo-skills'

export const name = 'dsh-team-memory'

function sendJson(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function sameOrigin(request: { headers: { origin?: string; host?: string } }): boolean {
  const { origin, host } = request.headers
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

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
  ctx.logger.info('dsh-team-memory: 已加载（T0/T1：事件 dump + 蒸馏管线 + 账本）')
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
      ]
      return () => { for (const d of disposers) d() }
    }, 'dsh-team-memory: http routes')
  })
}
