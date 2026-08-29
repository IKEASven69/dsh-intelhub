/**
 * T3 频道式 MD 投影：账本 → 人类可读的团队协作记录（可再生视图——账本是
 * 真相源，MD 随时重导）。结构：团队头(统计) → 团队记忆(类型分组+来源链) →
 * 成员私有 → 晋升历史 → 退役审计(谁在何时因何种理由退役)。
 */
import { foldLedger, readLedger } from './ledger.js'
import type { MemoryEntry } from './types.js'

const TYPE_LABEL: Record<string, string> = {
  chitchat: '闲聊', fact: '事实', decision: '决策', constraint: '约束', requirement: '需求',
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function memberName(scope: string): string {
  const parts = scope.split(':')
  return parts.length >= 3 ? parts.slice(2).join(':') : '（团队）'
}

function teamIdOf(scope: string): string {
  return scope.split(':')[1] ?? scope
}

/** 导出全部团队的 MD 投影（每团队一节）。 */
export function renderTeamMemoryMarkdown(): string {
  const view = foldLedger()
  const events = readLedger()

  // 按团队分组
  const byTeam = new Map<string, { team: MemoryEntry[]; priv: MemoryEntry[] }>()
  for (const e of view.entries) {
    const tid = teamIdOf(e.scope)
    const bucket = byTeam.get(tid) ?? { team: [], priv: [] }
    if (e.scope.split(':').length >= 3) bucket.priv.push(e)
    else bucket.team.push(e)
    byTeam.set(tid, bucket)
  }

  // 晋升与退役历史（审计）
  const promotions = events.filter((ev) => ev.kind === 'mem/promoted') as Extract<typeof events[number], { kind: 'mem/promoted' }>[]
  const retirements = view.retired

  const lines: string[] = []
  lines.push('# 团队记忆投影')
  lines.push('')
  lines.push(`> 导出时间：${new Date().toISOString()}`)
  lines.push('> 本文件是可再生视图（真相源为账本 ledger.jsonl）；请勿手编，重新导出即覆盖。')
  lines.push('')

  if (byTeam.size === 0) {
    lines.push('_暂无团队记忆。_')
    return lines.join('\n')
  }

  for (const [tid, { team, priv }] of byTeam) {
    lines.push(`## 团队 \`${tid}\``)
    lines.push('')
    lines.push(`- 团队层记忆：${team.length} 条 · 成员私有：${priv.length} 条`)
    const members = new Set(priv.map((e) => memberName(e.scope)))
    if (members.size > 0) lines.push(`- 成员：${[...members].join('、')}`)
    lines.push('')

    if (team.length > 0) {
      lines.push('### 团队共享记忆')
      lines.push('')
      for (const e of [...team].sort((a, b) => b.createdAt - a.createdAt)) {
        lines.push(`- **[${TYPE_LABEL[e.type] ?? e.type}]** ${e.text}`)
        const meta: string[] = [`强度 ×${e.strength}`, fmtDate(e.createdAt)]
        if (e.promotedFrom !== undefined && e.promotedFrom.length > 0) {
          meta.push(`晋升自 ${e.promotedFrom.length} 条私有（${e.promotedFrom.map((id) => id.slice(0, 6)).join(' / ')}）`)
        }
        lines.push(`  - ${meta.join(' · ')}`)
      }
      lines.push('')
    }

    if (priv.length > 0) {
      lines.push('### 成员私有记忆')
      lines.push('')
      const byMember = new Map<string, MemoryEntry[]>()
      for (const e of priv) {
        const list = byMember.get(memberName(e.scope)) ?? []
        list.push(e)
        byMember.set(memberName(e.scope), list)
      }
      for (const [name, list] of byMember) {
        lines.push(`#### ${name}（${list.length} 条）`)
        lines.push('')
        for (const e of [...list].sort((a, b) => b.createdAt - a.createdAt)) {
          lines.push(`- [${TYPE_LABEL[e.type] ?? e.type}] ${e.text}（×${e.strength}，${fmtDate(e.createdAt)}）`)
        }
        lines.push('')
      }
    }
  }

  // 晋升历史
  if (promotions.length > 0) {
    lines.push('## 晋升历史')
    lines.push('')
    for (const p of promotions) {
      lines.push(`- ${fmtDate(p.at)}：\`${memberName(p.entry.scope) === '（团队）' ? teamIdOf(p.entry.scope) : memberName(p.entry.scope)}\` 晋升「${p.entry.text.slice(0, 50)}${p.entry.text.length > 50 ? '…' : ''}」（源 ${p.fromIds.length} 条）`)
    }
    lines.push('')
  }

  // 退役审计
  if (retirements.length > 0) {
    lines.push('## 退役审计')
    lines.push('')
    lines.push('| 时间 | 条目 | 理由 |')
    lines.push('|---|---|---|')
    for (const r of retirements) {
      lines.push(`| ${fmtDate(r.at)} | \`${r.id.slice(0, 8)}\` | ${r.reason} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
