/**
 * 事件读取适配层：扫 ~/.dsh/sessions 下的 Lead 会话日志（session.jsonl.zstd），
 * zstd 解压后过滤 team/* 事件。rc.7 无该特性 → 本机通常扫到 0（fixture 与
 * 单测驱动开发；升级 rc.8 并真实跑团后此处即出真数据）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import type { TeamEvent } from './types.ts'

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

const TEAM_EVENT_TYPES = new Set(['team/member', 'team/task', 'team/message/queued', 'team/message/delivered'])

function decodeSessionLog(file: string): string {
  const buf = readFileSync(file)
  if (file.endsWith('.zstd')) {
    return zstdDecompressSync(buf).toString('utf8')
  }
  return buf.toString('utf8')
}

export interface TeamEventDump {
  sessionsScanned: number
  events: TeamEvent[]
  /** 各团队的事件数分布。 */
  byTeam: Record<string, number>
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
