/** doctor / import / 面板共用的类型。 */

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
  storePath: string
  storeExists: boolean | null
  modelNote: string
  guidance: string[]
}

/** 一个 agent 的会话发现结果（inventory）。 */
export interface AgentInventory {
  agent: string
  root: string
  sessions: number
  supported: boolean
  note?: string
}

export interface AgentTally {
  agent: string
  sessions: number
  candidates: number
  created: number
}

/** 迁移统计——诚实汇报：覆盖了多少会话/项目、各去重档位各多少条。 */
export interface ImportStats {
  dryRun: boolean
  startedAt: number
  finishedAt?: number
  sessionsFound: number
  sessionsScanned: number
  sessionsWithCandidates: number
  /** 增量跳过：指纹未变的会话。 */
  sessionsSkippedUnchanged: number
  /** .hippoignore 排除的会话。 */
  sessionsExcluded: number
  candidatesExtracted: number
  parseErrors: number
  created: number
  reinforced: number
  skipped: number
  maybe: number
  projects: { name: string; memories: number }[]
  byAgent: AgentTally[]
}

export interface ImportJob {
  id: string
  state: 'running' | 'done' | 'error'
  phase: string
  current: number
  total: number
  agent: string
  stats: ImportStats
  error?: string
}

/** 记忆库条目（浏览/搜索）。 */
export interface MemoryItem {
  id: string
  text: string
  type: string
  project: string
  agent: string
  createdAt: number
  strength: number
}

export interface MemoryPage {
  total: number
  offset: number
  limit: number
  items: MemoryItem[]
}
