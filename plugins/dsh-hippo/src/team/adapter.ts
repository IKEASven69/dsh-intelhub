/**
 * 事件读取适配层：扫 ~/.dsh/sessions 下的会话日志（session.jsonl.zstd）。
 * 两路事件源（0.1.1-rc.2 实测）：
 * 1. Agent Teams（team/member、team/task、team/message/*）——官方多 agent 运行时
 * 2. 旧版 subagent（subagent/descriptor 等）——标准模式的 continuable 子代理，
 *    也有团队语义（Lead 派发任务给子代理），映射为 member 事件纳入团队记忆
 * 注意：session.jsonl.zstd 是多帧 zstd 流（每追加写一帧）——zstdDecompressSync
 * 只解首帧会丢正文，必须用 fzstd 流式解全帧。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decompress as fzstdDecompress } from 'fzstd'
import type { TeamEvent } from './types.js'

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

const TEAM_EVENT_TYPES = new Set(['team/member', 'team/task', 'team/message/queued', 'team/message/delivered'])

function decodeSessionLog(file: string): string {
  const buf = readFileSync(file)
  if (file.endsWith('.zstd')) {
    return new TextDecoder().decode(fzstdDecompress(new Uint8Array(buf)))
  }
  return buf.toString('utf8')
}

export interface TeamEventDump {
  sessionsScanned: number
  events: TeamEvent[]
  /** 各团队的事件数分布。 */
  byTeam: Record<string, number>
}

/** 旧版 subagent（tool/call name=subagent）映射为团队事件——它也有
 * Lead→成员派活的团队语义，纳入团队记忆才不漏真数据。
 *
 * 两个事件源（都走 sourceRef 引用，不复制正文）：
 * 1. tool/call name=subagent → team/message/queued（Lead 派了什么活）
 * 2. 子代理自己会话的 assistant/message → team/message/delivered（子代理回了什么）
 * 蒸馏时配对成 Turn 流：prompt=user 轮、回复=assistant 轮 → extractCandidates。 */
interface SubagentSourceRef {
  sessionId: string
  lineSeq: number
  kind: 'subagent-prompt' | 'subagent-reply'
}

function subagentCallsToEvents(file: string, sessionDir: string, teamId: string): TeamEvent[] {
  const out: TeamEvent[] = []
  const sessionId = sessionDir.split(/[\\/]/).pop() ?? ''
  try {
    const text = decodeSessionLog(file)
    let seq = 0
    for (const line of text.split('\n')) {
      seq++
      if (!line.includes('"name":"subagent"')) continue
      try {
        const obj = JSON.parse(line) as { type?: string; time?: number; data?: { name?: string; arguments?: string } }
        if (obj.type !== 'tool/call' || obj.data?.name !== 'subagent') continue
        let prompt = ''
        let description = ''
        try {
          const args = JSON.parse(obj.data.arguments ?? '{}') as { prompt?: string; description?: string }
          prompt = args.prompt ?? ''
          description = args.description ?? ''
        } catch { /* arguments 不是 JSON 时留空 */ }
        const memberId = `sub:${description.trim() || prompt.trim().slice(0, 30)}`
        out.push({
          type: 'team/message/queued',
          teamId,
          seq: out.length,
          at: obj.time ?? 0,
          from: 'lead',
          to: memberId,
          message: { content: [] }, // 正文走 sourceRef，不复制
          sourceRef: { sessionId, lineSeq: seq, kind: 'subagent-prompt' } satisfies SubagentSourceRef,
        } as unknown as TeamEvent)
      } catch {
        continue
      }
    }
  } catch {
    // 尽力
  }
  return out
}

/** 子代理自己会话目录名不带 session- 前缀（dsh 后台 job id），
 *  里面的 assistant/message 是子代理的完整回复。扫出来映射为 delivered 事件。 */
function subagentRepliesToEvents(projDir: string, teamId: string): TeamEvent[] {
  const out: TeamEvent[] = []
  let sessionDirs: string[] = []
  try {
    sessionDirs = readdirSync(projDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('session-'))
      .map((d) => join(projDir, d.name))
  } catch {
    return out
  }
  for (const sessionDir of sessionDirs) {
    const sessionId = sessionDir.split(/[\\/]/).pop() ?? ''
    const file = join(sessionDir, 'session.jsonl.zstd')
    if (!existsSync(file)) continue
    try {
      const text = decodeSessionLog(file)
      let seq = 0
      for (const line of text.split('\n')) {
        seq++
        if (!line.includes('"assistant/message"')) continue
        try {
          const obj = JSON.parse(line) as { type?: string; time?: number; data?: { message?: { content?: Array<{ type: string; text: string }> } } }
          if (obj.type !== 'assistant/message') continue
          const hasContent = (obj.data?.message?.content ?? []).some((b) => b.type === 'text' && b.text.trim() !== '')
          if (!hasContent) continue // 只有 reasoning 没有 text 的跳过
          out.push({
            type: 'team/message/delivered',
            teamId,
            seq: out.length,
            at: obj.time ?? 0,
            from: `sub:${sessionId.slice(0, 8)}`,
            to: 'lead',
            message: { content: [] }, // 正文走 sourceRef
            sourceRef: { sessionId, lineSeq: seq, kind: 'subagent-reply' } satisfies SubagentSourceRef,
          } as unknown as TeamEvent)
        } catch {
          continue
        }
      }
    } catch {
      continue
    }
  }
  return out
}

/** 按 sourceRef 回读完整正文（prompt 或 reply，取决于 kind）。 */
export function resolveSubagentText(sourceRef: SubagentSourceRef): string {
  const projDirs = existsSync(SESSIONS_ROOT)
    ? readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(SESSIONS_ROOT, d.name))
    : []
  for (const projDir of projDirs) {
    const file = join(projDir, sourceRef.sessionId, 'session.jsonl.zstd')
    if (!existsSync(file)) continue
    try {
      const lines = decodeSessionLog(file).split('\n')
      const target = lines[sourceRef.lineSeq - 1]
      if (target === undefined) return ''
      const obj = JSON.parse(target) as { data?: { arguments?: string; message?: { content?: Array<{ type: string; text: string }> } } }
      if (sourceRef.kind === 'subagent-prompt') {
        const args = JSON.parse(obj.data?.arguments ?? '{}') as { prompt?: string }
        return args.prompt ?? ''
      }
      // subagent-reply：取 text 块（跳过 reasoning）
      return (obj.data?.message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
    } catch {
      continue
    }
  }
  return ''
}

/** 扫全部本地会话日志，抽出 team/* 事件（只读，不进成员私有会话内容）。 */
export function readTeamEvents(): TeamEventDump {
  const dump: TeamEventDump = { sessionsScanned: 0, events: [], byTeam: {} }
  if (!existsSync(SESSIONS_ROOT)) return dump
  let projectDirs: string[] = []
  try {
    projectDirs = readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(SESSIONS_ROOT, d.name))
  } catch {
    return dump
  }
  for (const projDir of projectDirs) {
    // 子代理回复事件（子代理自己会话目录不带 session- 前缀）
    const repliesTeamId = 'dsh-lead:' + (projDir.split(/[\\/]/).pop() ?? '').replace(/^--|--;$/g, '').slice(0, 12)
    for (const ev of subagentRepliesToEvents(projDir, repliesTeamId)) {
      dump.events.push(ev)
      dump.byTeam[repliesTeamId] = (dump.byTeam[repliesTeamId] ?? 0) + 1
    }
    let sessionDirs: string[] = []
    try {
      sessionDirs = readdirSync(projDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(projDir, d.name))
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      // 事件日志文件名形态：session.jsonl.zstd（rc.7 实测）
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const file = join(sessionDir, name)
        if (!existsSync(file)) continue
        dump.sessionsScanned += 1
        // 双源：官方 team/* + 旧版 subagent 派活（映射为 member 事件）
        const teamId = 'dsh-lead:' + (sessionDir.split(/[\\/]/).pop() ?? '').slice(0, 12)
        for (const ev of subagentCallsToEvents(file, sessionDir, teamId)) {
          dump.events.push(ev)
          dump.byTeam[teamId] = (dump.byTeam[teamId] ?? 0) + 1
        }
        try {
          for (const line of decodeSessionLog(file).split('\n')) {
            const t = line.trim()
            if (t === '' || !t.includes('"team/')) continue
            let obj: { type?: string; teamId?: string }
            try {
              obj = JSON.parse(t) as { type?: string; teamId?: string }
            } catch {
              continue
            }
            if (obj.type !== undefined && TEAM_EVENT_TYPES.has(obj.type) && typeof obj.teamId === 'string') {
              dump.events.push(obj as unknown as TeamEvent)
              dump.byTeam[obj.teamId] = (dump.byTeam[obj.teamId] ?? 0) + 1
            }
          }
        } catch {
          // 单会话解码失败不拖垮整体
        }
        break
      }
    }
  }
  return dump
}
