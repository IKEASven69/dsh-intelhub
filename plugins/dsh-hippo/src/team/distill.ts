/**
 * 蒸馏管线（T1，v2 两层模型）：
 * L1——每个成员只蒸馏自己的 reply 消息（per-agent scope）+ 完成任务的
 *      subject/description（lesson 候选）；写入 hippo 引擎做语义去重。
 * L2——晋升判定：跨成员语义互证（≥2 名成员的私有记忆相似 → 合并团队记忆，
 *      promotedFrom 带源链）。"一个坑被 ≥2 人独立踩到"是最硬团队级信号。
 * 引擎按 project 机制做 scope（team:<id>:<member> 私有 / team:<id> 共享）。
 */
import { randomUUID } from 'node:crypto'
import { withEngine, makeTurn, extractCandidates, type Turn } from '../hippo/engine.js'
import type { MemoryEntry, PromotionCandidate, ScanReport, TeamEvent, TeamMemoryType } from './types.js'
import { appendLedger, foldLedger } from './ledger.js'

/** 消息 → Turn（reply 是成员产出，按 assistant 轮；纯文本块拼接）。 */
function messageToTurn(ev: Extract<TeamEvent, { type: 'team/message/queued' }>): Turn | null {
  const text = ev.message.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim()
  if (text === '') return null
  return makeTurn({ role: 'assistant', text: text.slice(0, 4000), cwd: '' })
}

/** 完成任务 → lesson 候选轮（任务闭环本身是信号，subject+description 入文）。 */
function taskToTurn(ev: Extract<TeamEvent, { type: 'team/task' }>): Turn | null {
  if (ev.task.status !== 'completed') return null
  const text = `任务完成「${ev.task.subject}」：${ev.task.description}`.trim()
  if (text.length <= 12) return null
  return makeTurn({ role: 'assistant', text: text.slice(0, 2000), cwd: '', ts: '' })
}

/** 规则初判五分类（v2：语义分类留 refiner 钩子，T4 用真实数据对比后决定接 LLM）。 */
function classify(text: string): TeamMemoryType {
  if (/(必须|不要|禁止|约束|务必|constraint|must not)/i.test(text)) return 'constraint'
  if (/(决定|采用|方案[是定]|选型|decided|chose)/i.test(text)) return 'decision'
  if (/(需求|要求|需要实现|requirement|user story)/i.test(text)) return 'requirement'
  if (/(踩坑|根因|失败|教训|lesson|failed because)/i.test(text)) return 'fact'
  if (text.length < 24) return 'chitchat'
  return 'fact'
}

function privateScope(teamId: string, memberName: string): string {
  return `team:${teamId}:${memberName}`
}

export interface DistillOptions {
  /** 蒸馏后写引擎（默认 true；false 供单测/预览）。 */
  apply?: boolean
}

/**
 * 一轮扫描蒸馏：events → L1 私有（引擎+账本）→ L2 晋升判定（账本 mem/promoted）。
 * 幂等性：derivedFrom 带事件 id，重复扫同一事件由引擎三档去重兜底（reinforce 不新增）。
 */
export async function distillTeamEvents(
  events: TeamEvent[],
  opts: DistillOptions = {},
): Promise<ScanReport> {
  const apply = opts.apply !== false
  const teamId = events[0]?.teamId ?? 'unknown'
  const report: ScanReport = {
    teamId,
    sessionsScanned: 0,
    eventsSeen: events.length,
    members: 0,
    messagesDistilled: 0,
    tasksCompleted: 0,
    privateCreated: 0,
    promotedToTeam: 0,
    promotionQueued: 0,
  }

  const members = new Map<string, string>() // senderId → name
  const turnsByMember = new Map<string, { name: string; turns: Turn[]; sources: string[] }>()

  for (const ev of events) {
    if (ev.type === 'team/member') {
      members.set(ev.member.id, ev.member.name)
    } else if (ev.type === 'team/message/queued') {
      // 官方 Teams 路径：message.content 里有正文
      // 旧版 subagent 路径：sourceRef 引用，回读 prompt 作为 user 轮（上下文）
      const ref = (ev as unknown as { sourceRef?: { sessionId: string; lineSeq: number; kind: 'subagent-prompt' | 'subagent-reply' }, from?: string }).sourceRef
      if (ref?.kind === 'subagent-prompt') {
        const { resolveSubagentText } = await import('./adapter.js')
        const text = resolveSubagentText(ref)
        if (text.trim() === '') continue
        const senderId = (ev as unknown as { from?: string }).from ?? 'lead'
        const name = members.get(senderId) || senderId.slice(0, 8)
        members.set(senderId, name)
        const bucket = turnsByMember.get(senderId) ?? { name, turns: [] as Turn[], sources: [] as string[] }
        bucket.name = name
        bucket.turns.push(makeTurn({ role: 'user', text, cwd: '', ts: String((ev as unknown as { at?: number }).at ?? 0) }))
        bucket.sources.push(`${ref.sessionId}:${ref.lineSeq}`)
        turnsByMember.set(senderId, bucket)
        report.messagesDistilled += 1
        continue
      }
      const name = ev.message.senderName || members.get(ev.message.senderId) || ev.message.senderId.slice(0, 8)
      members.set(ev.message.senderId, name)
      const turn = messageToTurn(ev)
      if (turn === null) continue
      const bucket = turnsByMember.get(ev.message.senderId) ?? { name, turns: [], sources: [] }
      bucket.name = name
      bucket.turns.push(turn)
      bucket.sources.push(ev.message.id)
      turnsByMember.set(ev.message.senderId, bucket)
      report.messagesDistilled += 1
    } else if (ev.type === 'team/message/delivered') {
      // 旧版 subagent 路径（sourceRef 引用）：按指针回读正文
      const ref = (ev as unknown as { sourceRef?: { sessionId: string; lineSeq: number; kind: 'subagent-prompt' | 'subagent-reply' }, from?: string, at?: number }).sourceRef
      if (ref?.kind === 'subagent-reply') {
        const { resolveSubagentText } = await import('./adapter.js')
        const text = resolveSubagentText(ref)
        if (text.trim() === '') continue
        const senderId = (ev as unknown as { from?: string }).from ?? 'unknown'
        const name = members.get(senderId) || senderId.slice(0, 8)
        members.set(senderId, name)
        const bucket = turnsByMember.get(senderId) ?? { name, turns: [] as Turn[], sources: [] as string[] }
        bucket.name = name
        bucket.turns.push(makeTurn({ role: 'assistant', text, cwd: '', ts: String((ev as unknown as { at?: number }).at ?? 0) }))
        bucket.sources.push(`${ref.sessionId}:${ref.lineSeq}`)
        turnsByMember.set(senderId, bucket)
        report.messagesDistilled += 1
      }
    } else if (ev.type === 'team/task') {
      const turn = taskToTurn(ev)
      if (turn === null) continue
      report.tasksCompleted += 1
      const owner = ev.task.ownerId
      if (owner === undefined) continue
      const bucket = turnsByMember.get(owner) ?? { name: members.get(owner) ?? owner.slice(0, 8), turns: [], sources: [] }
      bucket.turns.push(turn)
      bucket.sources.push(ev.task.id)
      turnsByMember.set(owner, bucket)
    }
  }
  report.members = members.size

  // L1：逐成员蒸馏入引擎（scope=project）+ 账本
  const privateEntries: MemoryEntry[] = []
  if (turnsByMember.size > 0 && apply) {
    await withEngine(async ({ engine }) => {
      for (const [senderId, bucket] of turnsByMember) {
        const candidates = extractCandidates(bucket.turns).slice(0, 20) // top-N=20 质量门
        for (const c of candidates) {
          if (c.duplicate === 'reinforce') continue // 已有（重扫幂等）
          if (c.duplicate === 'maybe') continue // 0.8–0.93 永不自动落库（v2 定稿）
          const scope = privateScope(teamId, bucket.name)
          const ledgerType = classify(c.text)
          const r = await engine.remember(c.text, {
            type: toEngineType(ledgerType),
            project: scope,
            agent: 'team-memory',
          })
          if (r.status !== 'created') continue
          const entry: MemoryEntry = {
            id: randomUUID().replace(/-/g, '').slice(0, 24),
            scope,
            text: c.text,
            type: ledgerType,
            derivedFrom: [bucket.sources[0] ?? ''],
            createdAt: Date.now(),
            strength: 1,
          }
          privateEntries.push(entry)
          appendLedger({ kind: 'mem/created', at: Date.now(), entry })
          report.privateCreated += 1
        }
      }
    })
  }

  // L2：晋升判定（T2 起入队列不自动晋升）——跨成员语义互证产出
  // promo/candidate 候选（带证据链），由面板审批：promote/ignored/kept-private。
  if (apply && privateEntries.length >= 2) {
    await withEngine(async ({ engine, store }) => {
      const claimed = new Set<string>()
      const scopes = [teamScopeOf(teamId), ...[...turnsByMember.values()].map((b) => privateScope(teamId, b.name))]
      const seen = new Set(foldLedger().entries.filter((e) => !e.scope.includes(':', 5 + 1) ? false : e.scope.split(':').length < 3).map((e) => e.text)) // 幂等：仅团队层文本判重（私有层本来就该排队）
      for (const a of privateEntries) {
        if (claimed.has(a.id)) continue
        const vec = await engine.embedder(a.text)
        const hits = await store.hybridSearch(a.text, vec, scopes, 5)
        const cross = hits
          .map(([r, s]) => ({ r: r as { id?: string; project?: string; text?: string }, s: Number(s) }))
          .filter((h) => h.r.project !== undefined && h.r.project !== a.scope && h.r.project !== teamScopeOf(teamId))
        if (cross.length === 0) continue
        const text = a.text
        if (seen.has(text)) continue
        seen.add(text)
        const candidate: PromotionCandidate = {
          id: randomUUID().replace(/-/g, '').slice(0, 24),
          teamId,
          text,
          type: a.type,
          evidence: [
            { member: a.scope.split(':').pop() ?? '', entryId: a.id, text: a.text, sim: 1 },
            ...cross.slice(0, 2).map((h) => ({ member: (h.r.project ?? '').split(':').pop() ?? '', entryId: h.r.id ?? '', text: String(h.r.text ?? ''), sim: h.s })),
          ],
          createdAt: Date.now(),
        }
        appendLedger({ kind: 'promo/candidate', at: Date.now(), candidate })
        report.promotionQueued += 1
        claimed.add(a.id)
        for (const c of cross.slice(0, 2)) if (c.r.id !== undefined) claimed.add(c.r.id)
      }
    })
  }

  return report
}

function teamScopeOf(teamId: string): string {
  return `team:${teamId}`
}

/** 账本五分类 → 引擎四类型（constraint→preference 行为约束；requirement→fact）。 */
function toEngineType(t: TeamMemoryType): 'fact' | 'decision' | 'lesson' | 'preference' {
  if (t === 'constraint') return 'preference'
  if (t === 'requirement' || t === 'chitchat') return 'fact'
  return t
}
