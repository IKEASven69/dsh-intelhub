/**
 * T4 自我进化循环（务实版）：
 * - 衰减：类型基线 τ × 白名单豁免 × strength 访问强化——每周期产出衰减后的
 *   退役候选（喂给 T2 的分流）；衰减不直接删，只降 strength 触发分流。
 * - 周期报告：账本统计 + 晋升/退役/衰减汇总（LLM 总结钩子留位——v2 定稿
 *   "LLM 被证据拉进来"：真实团队数据落地后接 ctx.llm 生成协作洞察）。
 * - 预判卡：从高强团队记忆生成"下一步预判"（新任务开场注入的原料）。
 * - 调研复核：标记 fact 类老化条目为 evidence 档提案（真 web 复核等真数据）。
 */
import { appendLedger, foldLedger, readLedger } from './ledger.js'
import { withEngine } from '../hippo/engine.js'
import type { MemoryEntry } from './types.js'

/** 类型基线 τ（天）——决策/约束不衰减（白名单静态先验，v2 定稿）。 */
const TAU_DAYS: Record<string, number> = {
  chitchat: 7, fact: 45, decision: Infinity, constraint: Infinity, requirement: 90,
}

export interface CycleReport {
  at: number
  teamId: string
  decayed: { id: string; text: string; from: number; to: number }[]
  promoted: number
  retired: number
  evidenceProposals: { id: string; text: string; reason: string }[]
  forecastCards: { text: string; basis: string[] }[]
  note?: string
}

/**
 * 运行一个进化周期：衰减 → 退役候选 → 预判卡 → 报告。
 * 幂等：衰减按经过时间计算（不依赖运行频率）。
 */
export async function runCycle(teamId: string): Promise<CycleReport> {
  const now = Date.now()
  const view = foldLedger()
  const events = readLedger()
  const whitelisted = new Set(
    events.filter((ev) => ev.kind === 'whitelist/add').map((ev) => (ev as { text: string }).text),
  )
  const report: CycleReport = { at: now, teamId, decayed: [], promoted: 0, retired: view.retired.length, evidenceProposals: [], forecastCards: [] }

  // ① 衰减：strength × exp(-Δdays/τ)；τ=∞（决策/约束）与白名单跳过。
  // 衰减结果写引擎 strength（账本记 decay 事件审计）——低于 0.4 的进 evidence 提案。
  await withEngine(async ({ engine }) => {
    for (const e of view.entries) {
      if (!e.scope.startsWith(`team:${teamId}`)) continue
      if (TAU_DAYS[e.type] === Infinity || whitelisted.has(e.text)) continue
      const ageDays = (now - e.createdAt) / 86_400_000
      // strength 用访问强化模型：这里简化为基线衰减（recall 命中 +1 留给 K2/读侧）
      const target = Math.max(0.2, e.strength * Math.exp(-ageDays / (TAU_DAYS[e.type] ?? 45) / 4))
      if (target >= e.strength * 0.999) continue
      const before = e.strength
      // 账本记衰减事件（审计），引擎侧 strength 更新走 touch
      appendLedger({ kind: 'mem/decayed', at: now, id: e.id, from: before, to: Number(target.toFixed(2)) } as never)
      try { await engine.store.touch(e.id, { accessedAt: now / 1000, strength: Number(target.toFixed(2)) }) } catch { /* 引擎无此条则跳过 */ }
      report.decayed.push({ id: e.id, text: e.text, from: before, to: Number(target.toFixed(2)) })
      if (target < 0.5) {
        report.evidenceProposals.push({ id: e.id, text: e.text, reason: `强度衰减至 ${target.toFixed(2)}（${Math.floor(ageDays)} 天无强化）——建议复核是否仍成立` })
      }
    }
  })

  // ② 预判卡：高强团队记忆（≥2）各生成一张——新任务开场注入的原料
  const strong = view.entries
    .filter((e) => e.scope === `team:${teamId}` && e.strength >= 2)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 5)
  for (const e of strong) {
    report.forecastCards.push({
      text: e.text,
      basis: (e.promotedFrom ?? []).map((id) => id.slice(0, 6)),
    })
  }

  // ③ LLM 总结钩子：真实团队数据落地后接 ctx.llm（dsh 侧）生成协作洞察
  report.note = 'LLM 协作洞察待真实团队数据落地后接入（v2：LLM 被证据拉进来，不预埋）'

  return report
}
