/**
 * 会话适配器注册表：一个适配器，三个消费者（GUI 会话浏览 / distill 蒸馏 / dsh 插件 import）。
 * 新增 agent = 写一个 adapter 文件 + 在 AGENTS 里注册一行。
 */
import type { AgentInventory, SessionAdapter, SessionRef } from './types.js'
import type { Turn } from '../patterns/transcript.js'
import { claudeAdapter } from './claude.js'
import { codexAdapter } from './codex.js'
import { opencodeAdapter } from './opencode.js'
import { zcodeAdapter } from './zcode.js'
import { piAdapter } from './pi.js'
import { workbuddyAdapter } from './workbuddy.js'

export const AGENTS: SessionAdapter[] = [
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
  zcodeAdapter,
  piAdapter,
  workbuddyAdapter,
]

const byName = new Map(AGENTS.map((a) => [a.name, a]))

export function inventory(): AgentInventory[] {
  return AGENTS.map((a) => ({
    agent: a.name,
    root: a.root,
    sessions: a.supported ? a.discover().length : 0,
    supported: a.supported,
    note: a.note,
  }))
}

export function discoverAll(): SessionRef[] {
  const out: SessionRef[] = []
  for (const a of AGENTS) {
    if (!a.supported) continue
    try {
      out.push(...a.discover())
    } catch {
      // 单家失败不拖垮整体发现
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function parseSession(agent: string, id: string): Turn[] {
  const a = byName.get(agent)
  if (a === undefined || !a.supported) return []
  try {
    return a.parse(id)
  } catch {
    return []
  }
}

export type { SessionAdapter, SessionRef, AgentInventory, IgnoreRules, ImportState } from './types.js'
export { loadIgnoreRules } from './ignore.js'
export { readImportState, writeImportState } from './state.js'
export { parseCodexText } from './codex.js'
export { parseOpenCodeSession } from './opencode.js'
export { parseZcodeSession } from './zcode.js'
// 会话索引层（G1）：GUI 搜索/详情/导出/蒸馏记录的数据面
export {
  syncSessionIndex, listSessions, getIndexedSession, searchSessions,
  indexStats, turnCountMap, recordSessionDistill, listSessionDistills,
} from './session-index.js'
export type { IndexedSession, SessionSearchHit, SyncResult, SessionDistillRecord } from './session-index.js'
export { renderSessionMarkdown, renderSessionJson, safeFileStem } from './export.js'
