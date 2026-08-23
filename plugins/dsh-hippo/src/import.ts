/**
 * 迁移任务编排：引擎 agents 层负责发现/解析/排除/增量指纹，这里只做
 * distill 循环、任务状态与诚实统计。G0 起增量：指纹未变的会话直接跳过。
 * @module dsh-hippo/import
 */

import {
  discoverAll,
  distill,
  extractCandidates,
  inventory,
  loadIgnoreRules,
  openEngine,
  parseSession,
  readImportState,
  writeImportState,
  type ImportState,
  type SessionRef,
} from 'hippo-mind'
import type { AgentInventory, ImportJob, ImportStats } from './types.ts'

export { inventory }

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
    sessionsSkippedUnchanged: 0,
    sessionsExcluded: 0,
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
 * 启动迁移（增量）。返回任务快照；已在跑时抛错（路由层转 409）。
 * dryRun=true 只统计不写入。
 */
export function startImport(opts: { dryRun: boolean }): ImportJob {
  if (job !== null && job.state === 'running') throw new Error('迁移正在进行中')

  const rules = loadIgnoreRules()
  const all = discoverAll()
  const excluded = all.filter((s) => rules.isIgnored(s))
  const refs = all.filter((s) => !rules.isIgnored(s))

  const state = readImportState()
  const pending = refs.filter((s) => state[s.agent]?.[s.id] !== s.fingerprint)

  job = {
    id: `imp-${Date.now().toString(36)}`,
    state: 'running',
    phase: pending.length === 0 ? '' : '准备嵌入模型（首次运行需下载 bge-m3，约 2GB）',
    current: 0,
    total: pending.length,
    agent: '',
    stats: emptyStats(opts.dryRun),
  }
  const stats = job.stats
  stats.sessionsFound = all.length
  stats.sessionsExcluded = excluded.length
  stats.sessionsSkippedUnchanged = refs.length - pending.length

  const projects = new Map<string, number>()
  const byAgent = new Map<string, { agent: string; sessions: number; candidates: number; created: number }>()

  void (async () => {
    let opened: ReturnType<typeof openEngine> | null = null
    try {
      if (pending.length > 0) {
        const op = openEngine()
        opened = op
        await op.engine.embedder('hippo import warmup')
        job.phase = ''
        for (const ref of pending as SessionRef[]) {
          job.agent = ref.agent
          const tally = byAgent.get(ref.agent) ?? { agent: ref.agent, sessions: 0, candidates: 0, created: 0 }
          byAgent.set(ref.agent, tally)
          let turns
          try {
            turns = parseSession(ref.agent, ref.id)
          } catch {
            stats.parseErrors += 1
            job.current += 1
            continue
          }
          stats.sessionsScanned += 1
          tally.sessions += 1
          if (turns.length === 0) { markProcessed(state, ref); job.current += 1; continue }
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
          if (candidates.length === 0) { markProcessed(state, ref); job.current += 1; continue }
          stats.sessionsWithCandidates += 1
          const result = await distill(opened.engine, candidates, { apply: !opts.dryRun, agent: `import:${ref.agent}`, turns })
          stats.created += result.created
          stats.reinforced += result.reinforced
          stats.skipped += result.skipped
          stats.maybe += result.maybe
          tally.created += result.created
          // dry-run 时 distill 不落库也不计数，从候选档位汇总出"预览将发生什么"
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
          markProcessed(state, ref)
          job.current += 1
        }
      }
      writeImportState(state)
      stats.projects = [...projects.entries()]
        .map(([name, memories]) => ({ name, memories }))
        .sort((a, b) => b.memories - a.memories)
        .slice(0, 20)
      stats.byAgent = [...byAgent.values()].sort((a, b) => b.created - a.created)
      stats.finishedAt = Date.now()
      job.state = 'done'
      job.phase = ''
    } catch (e) {
      // 已处理过的仍写入状态，避免失败后全量重来
      try { writeImportState(state) } catch { /* 状态写失败不掩盖原始错误 */ }
      job.state = 'error'
      job.error = e instanceof Error ? e.message : String(e)
    } finally {
      opened?.close()
    }
  })()

  return job
}

function markProcessed(state: ImportState, ref: SessionRef): void {
  const bucket = state[ref.agent] ?? (state[ref.agent] = {})
  bucket[ref.id] = ref.fingerprint
}
