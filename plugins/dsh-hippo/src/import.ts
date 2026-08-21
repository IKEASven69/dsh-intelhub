/**
 * 会话发现与迁移管线：Claude Code（原生解析）/ Codex rollout / opencode 三层存储，
 * 统一转成引擎 Turn 流，走 extractCandidates → distill（apply/dryRun）。
 * 统计诚实汇报：覆盖会话/项目数、四个去重档位各多少条（PLAN H1）。
 * @module dsh-hippo/import
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  distill,
  entryToTurns,
  extractCandidates,
  makeTurn,
  openEngine,
  parseJsonl,
  type Turn,
} from 'hippo-skills'
import type { AgentInventory, ImportJob, ImportStats } from './types.ts'

// ---------------------------------------------------------------------------
// 会话发现
// ---------------------------------------------------------------------------

function* walkJsonl(dir: string): Generator<string> {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkJsonl(p)
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p
  }
}

const AGENTS: { name: string; root: string; supported: boolean; note?: string; discover: () => string[] }[] = [
  {
    name: 'claude-code',
    root: join(homedir(), '.claude', 'projects'),
    supported: true,
    discover() {
      return [...walkJsonl(this.root)]
    },
  },
  {
    name: 'codex',
    root: join(homedir(), '.codex', 'sessions'),
    supported: true,
    discover() {
      return [...walkJsonl(this.root)]
    },
  },
  {
    name: 'opencode',
    root: join(homedir(), '.local', 'share', 'opencode', 'storage'),
    supported: true,
    discover() {
      const out: string[] = []
      const sessionRoot = join(this.root, 'session')
      let projects: string[]
      try {
        projects = readdirSync(sessionRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(sessionRoot, d.name))
      } catch {
        return out
      }
      for (const projDir of projects) {
        let names: string[]
        try {
          names = readdirSync(projDir)
        } catch {
          continue
        }
        for (const f of names) {
          if (f.endsWith('.json')) out.push(join(projDir, f))
        }
      }
      return out
    },
  },
]

export function inventory(): AgentInventory[] {
  return AGENTS.map((a) => ({
    agent: a.name,
    root: a.root,
    sessions: a.discover().length,
    supported: a.supported,
    note: a.note,
  }))
}

// ---------------------------------------------------------------------------
// 解析器：三种格式 → Turn[]
// ---------------------------------------------------------------------------

function parseJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Claude Code transcript JSONL：引擎原生格式。 */
function parseClaude(file: string): Turn[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const turns: Turn[] = []
  for (const entry of parseJsonl(text)) turns.push(...entryToTurns(entry))
  return turns
}

interface CodexLine { timestamp?: string; type?: string; payload?: Record<string, unknown> }

/** Codex rollout JSONL：session_meta 提 cwd，response_item 是权威消息流（event_msg 为 UI 事件，跳过避免重复）。 */
function parseCodex(file: string): Turn[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  let cwd = ''
  const turns: Turn[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj: CodexLine
    try {
      obj = JSON.parse(line) as CodexLine
    } catch {
      continue
    }
    const ts = obj.timestamp ?? ''
    if (obj.type === 'session_meta') {
      cwd = typeof obj.payload?.cwd === 'string' ? (obj.payload.cwd as string) : ''
      continue
    }
    if (obj.type !== 'response_item' || obj.payload === undefined) continue
    const p = obj.payload
    if (p.type === 'message') {
      const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : ''
      if (!role) continue // system/developer 基线提示是噪声
      const content = Array.isArray(p.content) ? p.content : []
      const body = content
        .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
        .filter(Boolean)
        .join('\n')
      if (body) turns.push(makeTurn({ role, text: body, cwd, ts, model: typeof p.model === 'string' ? p.model : '' }))
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const name = typeof p.name === 'string' ? p.name : String(p.type)
      turns.push(makeTurn({ role: 'tool', text: name, cwd, ts, toolName: name }))
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')
      turns.push(makeTurn({ role: 'tool', text: out.slice(0, 2000), cwd, ts, toolFailed: /\berror\b/i.test(out.slice(0, 400)) }))
    }
  }
  return turns
}

interface OpenCodeSession { id?: string; directory?: string }
interface OpenCodeMessage { id?: string; role?: string; time?: { created?: number }; modelID?: string }
interface OpenCodePart { type?: string; text?: string; tool?: string; state?: { status?: string } }

/** opencode 三层存储：session/<proj>/ses_*.json + message/<ses>/msg_*.json + part/<msg>/prt_*.json。 */
function parseOpenCode(file: string, storageRoot: string): Turn[] {
  const session = parseJsonFile<OpenCodeSession>(file)
  if (!session?.id) return []
  const cwd = session.directory ?? ''
  const msgDir = join(storageRoot, 'message', session.id)
  let msgFiles: string[]
  try {
    msgFiles = readdirSync(msgDir).filter((f) => f.endsWith('.json')).map((f) => join(msgDir, f))
  } catch {
    return []
  }
  const msgs = msgFiles
    .map((f) => parseJsonFile<OpenCodeMessage>(f))
    .filter((m): m is OpenCodeMessage => m !== null && (m.role === 'user' || m.role === 'assistant') && typeof m.id === 'string')
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  const turns: Turn[] = []
  for (const m of msgs) {
    const partDir = join(storageRoot, 'part', m.id as string)
    let partFiles: string[]
    try {
      partFiles = readdirSync(partDir).filter((f) => f.endsWith('.json')).map((f) => join(partDir, f))
    } catch {
      partFiles = []
    }
    const parts = partFiles.map((f) => parseJsonFile<OpenCodePart>(f)).filter((p): p is OpenCodePart => p !== null)
    const body = parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text as string).join('\n')
    const ts = m.time?.created ? new Date(m.time.created).toISOString() : ''
    if (body) {
      turns.push(makeTurn({
        role: m.role === 'user' ? 'user' : 'assistant',
        text: body,
        cwd,
        ts,
        model: m.modelID ?? '',
      }))
    }
    for (const p of parts) {
      if (p.type !== 'tool') continue
      turns.push(makeTurn({
        role: 'tool',
        text: (p.text ?? '').slice(0, 2000),
        cwd,
        ts,
        toolName: p.tool ?? '',
        toolFailed: p.state?.status === 'error',
      }))
    }
  }
  return turns
}

// ---------------------------------------------------------------------------
// 迁移任务
// ---------------------------------------------------------------------------

let job: ImportJob | null = null

export function currentJob(): ImportJob | null {
  return job
}

function emptyStats(dryRun: boolean): ImportStats {
  return {
    dryRun,
    startedAt: Date.now(),
    sessionsFound: 0,
    sessionsScanned: 0,
    sessionsWithCandidates: 0,
    candidatesExtracted: 0,
    parseErrors: 0,
    created: 0,
    reinforced: 0,
    skipped: 0,
    maybe: 0,
    projects: [],
    byAgent: [],
  }
}

/**
 * 启动迁移。返回任务快照；已在跑时抛错（路由层转 409）。
 * dryRun=true 只统计不写入（maybe 档复核预览用）。
 */
export function startImport(opts: { dryRun: boolean }): ImportJob {
  if (job !== null && job.state === 'running') throw new Error('迁移正在进行中')
  const files: { agent: string; file: string }[] = []
  for (const a of AGENTS) {
    for (const f of a.discover()) files.push({ agent: a.name, file: f })
  }
  job = {
    id: `imp-${Date.now().toString(36)}`,
    state: 'running',
    phase: '准备嵌入模型（首次运行需下载 bge-m3，约 2GB）',
    current: 0,
    total: files.length,
    agent: '',
    stats: emptyStats(opts.dryRun),
  }
  job.stats.sessionsFound = files.length

  const stats = job.stats
  const projects = new Map<string, number>()
  const byAgent = new Map<string, { agent: string; sessions: number; candidates: number; created: number }>()

  void (async () => {
    let opened: ReturnType<typeof openEngine> | null = null
    try {
      opened = openEngine()
      await opened.engine.embedder('hippo import warmup')
      job.phase = ''
      for (const { agent, file } of files) {
        job.agent = agent
        const tally = byAgent.get(agent) ?? { agent, sessions: 0, candidates: 0, created: 0 }
        byAgent.set(agent, tally)
        let turns: Turn[]
        try {
          if (agent === 'claude-code') turns = parseClaude(file)
          else if (agent === 'codex') turns = parseCodex(file)
          else turns = parseOpenCode(file, AGENTS[2].root)
        } catch {
          stats.parseErrors += 1
          job.current += 1
          continue
        }
        stats.sessionsScanned += 1
        tally.sessions += 1
        if (turns.length === 0) { job.current += 1; continue }
        let candidates
        try {
          candidates = extractCandidates(turns)
        } catch {
          stats.parseErrors += 1
          job.current += 1
          continue
        }
        stats.candidatesExtracted += candidates.length
        tally.candidates += candidates.length
        if (candidates.length === 0) { job.current += 1; continue }
        stats.sessionsWithCandidates += 1
        const result = await distill(opened.engine, candidates, { apply: !opts.dryRun, agent: `import:${agent}`, turns })
        stats.created += result.created
        stats.reinforced += result.reinforced
        stats.skipped += result.skipped
        stats.maybe += result.maybe
        tally.created += result.created
        // dry-run 时 distill 不落库也不计数，从候选的档位分类汇总出"预览将发生什么"。
        if (opts.dryRun) {
          for (const c of candidates) {
            if (c.duplicate === 'new') { stats.created += 1; tally.created += 1 }
            else if (c.duplicate === 'reinforce') stats.reinforced += 1
            else if (c.duplicate === 'maybe') stats.maybe += 1
          }
        }
        for (const c of candidates) {
          if (c.duplicate === 'new' && c.project) projects.set(c.project, (projects.get(c.project) ?? 0) + 1)
        }
        job.current += 1
      }
      stats.projects = [...projects.entries()]
        .map(([name, memories]) => ({ name, memories }))
        .sort((a, b) => b.memories - a.memories)
        .slice(0, 20)
      stats.byAgent = [...byAgent.values()].sort((a, b) => b.created - a.created)
      stats.finishedAt = Date.now()
      job.state = 'done'
      job.phase = ''
    } catch (e) {
      job.state = 'error'
      job.error = e instanceof Error ? e.message : String(e)
    } finally {
      opened?.close()
    }
  })()

  return job
}
