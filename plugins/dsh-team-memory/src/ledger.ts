/**
 * append-only JSONL 事件账本（真相源，v2 定稿）：退役=retire 事件带
 * supersededBy/reason，fold 过滤当前视图——并发免锁、审计免费。
 * 位置：<dataDir>/team-memory/ledger.jsonl（dataDir 复用引擎的 ~/.hippo）。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LedgerEvent, MemoryEntry } from './types.ts'

// 账本跟随引擎的 dataDir（HIPPO_DATA_DIR 可覆盖；引擎侧 store.ts 同一约定）
function dataDir(): string {
  return process.env.HIPPO_DATA_DIR ?? join(homedir(), '.hippo')
}
function ledgerPathIn(): string {
  return join(dataDir(), 'team-memory', 'ledger.jsonl')
}
let LEDGER_PATH = ledgerPathIn()

export function ledgerPath(): string {
  return LEDGER_PATH
}

export function appendLedger(event: LedgerEvent): void {
  LEDGER_PATH = ledgerPathIn()
  mkdirSync(dirname(LEDGER_PATH), { recursive: true })
  appendFileSync(LEDGER_PATH, JSON.stringify(event) + '\n', 'utf8')
}

export function readLedger(): LedgerEvent[] {
  if (!existsSync(LEDGER_PATH)) return []
  const out: LedgerEvent[] = []
  for (const line of readFileSync(LEDGER_PATH, 'utf8').split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      out.push(JSON.parse(t) as LedgerEvent)
    } catch {
      // 脏行跳过：账本只增不改，坏行不拖垮 fold
    }
  }
  return out
}

export interface FoldView {
  /** 当前有效条目（未退役；被 superseded 的由新条目自然取代语义）。 */
  entries: MemoryEntry[]
  /** 退役记录（审计用）。 */
  retired: { id: string; at: number; supersededBy?: string; reason: string }[]
}

/** fold：created → 未被 retire 的即当前视图；同 id 后写覆盖先写。 */
export function foldLedger(): FoldView {
  const events = readLedger()
  const byId = new Map<string, MemoryEntry>()
  const retiredIds = new Set<string>()
  const retired: FoldView['retired'] = []
  for (const ev of events) {
    if (ev.kind === 'mem/created' || ev.kind === 'mem/promoted') {
      byId.set(ev.entry.id, ev.entry)
      retiredIds.delete(ev.entry.id)
    } else if (ev.kind === 'mem/retired') {
      retiredIds.add(ev.id)
      retired.push({ id: ev.id, at: ev.at, supersededBy: ev.supersededBy, reason: ev.reason })
    }
  }
  return {
    entries: [...byId.values()].filter((e) => !retiredIds.has(e.id)),
    retired,
  }
}
