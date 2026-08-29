/**
 * T2 分诊与审批动作：
 * - 晋升队列：fold 出未 resolved 的 promo/candidate；
 *   approve(action) → promoted（引擎入库+账本）/ ignored / kept-private（私有保留）。
 * - 退役分流：三级规则（v2 定稿）——闲聊=auto；决策/约束老化且强度未强化=approval；
 *   evidence 档由 T4 调研循环产出（当前无来源则空，诚实留位）。
 * - 白名单：whitelist/add 事件——决策/约束"保留"即入，永不进 approval 档。
 */
import { randomUUID } from 'node:crypto'
import { withEngine } from '../hippo/engine.js'
import type { MemoryEntry, PromotionCandidate, RetirementCandidate } from './types.js'
import { appendLedger, foldLedger, readLedger } from './ledger.js'

export interface TriageView {
  promotions: PromotionCandidate[]
  retirements: RetirementCandidate[]
  stats: { team: number; private: number; promoted: number; retired: number }
}

/** 晋升队列 + 退役候选 + 统计（一次 fold 出全部分诊视图）。 */
export function triage(opts: { staleDays?: number } = {}): TriageView {
  const staleDays = opts.staleDays ?? 45
  const view = foldLedger()
  const events = readLedger()

  const resolved = new Set<string>()
  for (const ev of events) {
    if (ev.kind === 'promo/resolved') resolved.add(ev.id)
  }
  const promotions: PromotionCandidate[] = []
  for (const ev of events) {
    if (ev.kind === 'promo/candidate' && !resolved.has(ev.candidate.id)) {
      promotions.push(ev.candidate)
    }
  }

  // 白名单：被"保留"过的条目文本（决策/约束类，永不进 approval 档）
  const whitelisted = new Set<string>()
  for (const ev of events) {
    if (ev.kind === 'whitelist/add' && typeof ev.text === 'string') whitelisted.add(ev.text)
  }

  const now = Date.now()
  const retirements: RetirementCandidate[] = []
  for (const e of view.entries) {
    // 团队层才有退役意义；私有层随成员归档（v2 定稿）
    if (!e.scope.split(':').length || e.scope.split(':').length < 2) continue
    const ageDays = Math.floor((now - e.createdAt) / 86_400_000)
    if (e.type === 'chitchat') {
      retirements.push({
        entryId: e.id, scope: e.scope, text: e.text, type: e.type, tier: 'auto',
        reason: '闲聊类 · 分级寿命到档', ageDays, strength: e.strength,
      })
    } else if ((e.type === 'decision' || e.type === 'fact') && ageDays >= staleDays && e.strength <= 1 && !whitelisted.has(e.text)) {
      retirements.push({
        entryId: e.id, scope: e.scope, text: e.text, type: e.type, tier: 'approval',
        reason: `${e.type === 'decision' ? '决策' : '事实'}类 ${ageDays} 天未强化——请确认是否仍成立`, ageDays, strength: e.strength,
      })
    }
    // evidence 档：T4 调研循环产出（web 复核过期 → 退役提案附证据），当前留位
  }

  let team = 0
  let priv = 0
  for (const e of view.entries) {
    if (e.scope.split(':').length >= 3) priv += 1
    else if (e.scope.startsWith('team:')) team += 1
  }
  return {
    promotions,
    retirements,
    stats: { team, private: priv, promoted: team, retired: view.retired.length },
  }
}

export type PromotionAction = 'promoted' | 'ignored' | 'kept-private'

/** 审批一条晋升候选。promoted 时入库引擎 team scope（mergedText 可编辑）。 */
export async function resolvePromotion(candidateId: string, action: PromotionAction, mergedText?: string): Promise<{ ok: boolean; error?: string }> {
  const events = readLedger()
  const cand = events.find((ev): ev is Extract<typeof ev, { kind: 'promo/candidate' }> => ev.kind === 'promo/candidate' && ev.candidate.id === candidateId)?.candidate
  if (cand === undefined) return { ok: false, error: '候选不存在或已处理' }
  const resolved = new Set(events.filter((ev) => ev.kind === 'promo/resolved').map((ev) => (ev as { id: string }).id))
  if (resolved.has(candidateId)) return { ok: false, error: '候选已处理' }

  if (action === 'promoted') {
    const text = (mergedText ?? cand.text).trim()
    if (text === '') return { ok: false, error: '合并文本为空' }
    const entry: MemoryEntry = {
      id: randomUUID().replace(/-/g, '').slice(0, 24),
      scope: `team:${cand.teamId}`,
      text,
      type: cand.type,
      derivedFrom: cand.evidence.map((e) => e.entryId),
      createdAt: Date.now(),
      strength: 2,
      promotedFrom: cand.evidence.map((e) => e.entryId),
    }
    await withEngine(async ({ engine }) => {
      await engine.remember(text, {
        type: entry.type === 'constraint' ? 'preference' : entry.type === 'requirement' || entry.type === 'chitchat' ? 'fact' : entry.type,
        project: entry.scope,
        agent: 'team-memory',
      })
    })
    appendLedger({ kind: 'mem/promoted', at: Date.now(), fromIds: entry.promotedFrom ?? [], entry })
  }
  appendLedger({ kind: 'promo/resolved', at: Date.now(), id: candidateId, action })
  return { ok: true }
}

/** 审批一条退役候选（auto/approval 档共用）：retire 或 keep（keep=白名单）。 */
export function resolveRetirement(entryId: string, action: 'retire' | 'keep', reason?: string): { ok: boolean; error?: string } {
  const view = foldLedger()
  const entry = view.entries.find((e) => e.id === entryId)
  if (entry === undefined) return { ok: false, error: '条目不存在或已退役' }
  if (action === 'retire') {
    appendLedger({ kind: 'mem/retired', at: Date.now(), id: entryId, reason: reason ?? '面板审批退役' })
  } else {
    appendLedger({ kind: 'whitelist/add', at: Date.now(), text: entry.text })
  }
  return { ok: true }
}
