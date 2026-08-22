/**
 * team-memory 共享类型。事件形态照抄 harness rc.8 agent-team 的 fold.ts
 * schema（TeamMemberSnapshot/TeamTaskSnapshot/TeamMessageSnapshot）——适配层
 * 隔离升级差异（PLAN 四·风险对策），rc 间改名只改这里。
 */

// ── rc.8 事件（team/* 存于 Lead 会话事件日志）──────────────────────

export interface TeamMemberSnapshot {
  id: string
  name: string
  description: string
  provider: string
  context: 'fresh' | 'fork'
  phase: 'provisioning' | 'active' | 'failed'
  error?: string
}

export interface TeamTaskSnapshot {
  id: string
  revision: number
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  ownerId?: string
  blockedBy: string[]
  writeScopes: string[]
}

export interface ContentBlock {
  type: string
  text?: string
  isError?: boolean
  [k: string]: unknown
}

export interface TeamMessageSnapshot {
  id: string
  senderId: string
  senderName: string
  targetId: string
  delivery: 'quiet' | 'wakeup'
  content: ContentBlock[]
}

export type TeamEvent =
  | { type: 'team/member'; version: 1; teamId: string; member: TeamMemberSnapshot }
  | { type: 'team/task'; version: 1; teamId: string; task: TeamTaskSnapshot }
  | { type: 'team/message/queued'; version: 1; teamId: string; message: TeamMessageSnapshot }
  | { type: 'team/message/delivered'; version: 1; teamId: string; messageId: string; targetId: string }

// ── 记忆账本（append-only JSONL，真相源）──────────────────────────

/** 五分类（v2 定稿：refiner 是语义任务，T1 用规则初判留钩子）。 */
export type TeamMemoryType = 'chitchat' | 'fact' | 'decision' | 'constraint' | 'requirement'

/** 一条团队记忆（L2 共享层）或成员私有记忆（L1，scope 带成员名）。 */
export interface MemoryEntry {
  id: string
  /** L1 私有：team:<teamId>:<memberName>；L2 共享：team:<teamId>。 */
  scope: string
  text: string
  type: TeamMemoryType
  /** 来源事件链（审计/溯源）。 */
  derivedFrom: string[]
  createdAt: number
  strength: number
  /** 晋升来源（L2 条目）：印证它的 L1 条目 id 列表。 */
  promotedFrom?: string[]
}

export type LedgerEvent =
  | { kind: 'mem/created'; at: number; entry: MemoryEntry }
  | { kind: 'mem/retired'; at: number; id: string; supersededBy?: string; reason: string }
  | { kind: 'mem/promoted'; at: number; fromIds: string[]; entry: MemoryEntry }

export interface ScanReport {
  teamId: string
  sessionsScanned: number
  eventsSeen: number
  members: number
  messagesDistilled: number
  tasksCompleted: number
  privateCreated: number
  promotedToTeam: number
}
