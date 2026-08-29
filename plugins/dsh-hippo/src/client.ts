/**
 * dsh-hippo 浏览器半：设置页「记忆桥」。
 * 数据通路走同源 fetch 直连 host 路由（dshmarket 第三方先例）。
 * H1：doctor 自检 + 会话发现 + 迁移（预览/执行）+ 诚实统计汇报。
 * @module dsh-hippo/client
 */

import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { AgentInventory, DoctorReport, ImportJob, MemoryItem, MemoryPage } from './types.ts'

export const inject = ['slots']

// ---------------------------------------------------------------------------
// 独立记忆面板：sidebar.footer.action 入口图标 + shell.overlay 浮层（模块级开关态，
// 同插件的两个注册共享；不进设置模态，不与其他插件挤 settings 区）
// ---------------------------------------------------------------------------

type AutoStatus = {
  settings: { mode: 'off' | 'review' | 'auto'; threshold: number; intervalMin: number; lastRun?: { scanned: number; created: number; shelved: number } | null }
  shelvedCount: number
}
type ShelvedItem = { index: number; reason: string; project: string; type: string; confidence: number; text: string }

const overlayStore = {
  open: false,
  listeners: new Set<() => void>(),
  toggle(): void {
    overlayStore.open = !overlayStore.open
    for (const l of overlayStore.listeners) l()
  },
  close(): void {
    overlayStore.open = false
    for (const l of overlayStore.listeners) l()
  },
  subscribe(fn: () => void): () => void {
    overlayStore.listeners.add(fn)
    return () => { overlayStore.listeners.delete(fn) }
  },
}

// ---------------------------------------------------------------------------
// 样式：渐变主视觉 + 卡片体系 + 微动效；颜色尽量继承宿主令牌（--accent/--border/--muted），
// 兜底值保证浅色可读；prefers-reduced-motion 全量降级。
// ---------------------------------------------------------------------------

const CSS = `
.hb-panel { display: flex; flex-direction: column; gap: 16px; padding: 4px 0; --hb-a: var(--accent, #2563eb); --hb-b: #7c3aed;
  --hb-ok: #15803d; --hb-warn: #b45309; --hb-err: #d93025; --hb-line: var(--border, rgba(127,127,127,.28));
  --hb-mut: var(--muted, rgba(127,127,127,.92)); --hb-card: var(--bg, rgba(127,127,127,.05)); }
.hb-card { background: var(--hb-card); border: 1px solid var(--hb-line); border-radius: 12px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px; animation: hbIn .34s ease both; }
.hb-card:nth-child(2) { animation-delay: .05s; } .hb-card:nth-child(3) { animation-delay: .1s; }
.hb-card:nth-child(4) { animation-delay: .15s; } .hb-card:nth-child(5) { animation-delay: .2s; }
@keyframes hbIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.hb-hero { display: flex; align-items: center; gap: 12px; }
.hb-logo { width: 40px; height: 40px; border-radius: 11px; flex: none; display: grid; place-items: center;
  background: linear-gradient(135deg, var(--hb-a), var(--hb-b)); color: #fff; font-weight: 800; font-size: 15px;
  box-shadow: 0 4px 14px rgba(37,99,235,.35); letter-spacing: .5px; }
.hb-hero-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.hb-title { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 8px; }
.hb-sub { font-size: 12px; color: var(--hb-mut); }
.hb-beta { font-size: 10px; font-weight: 600; padding: 1px 8px; border-radius: 999px; flex: none;
  color: var(--hb-warn); border: 1px solid; border-image: none; box-shadow: inset 0 0 0 999px rgba(180,83,9,.07); }
.hb-spacer { flex: 1; }

.hb-btn { cursor: pointer; border-radius: 9px; font-size: 13px; padding: 7px 16px; border: 1px solid transparent;
  transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease; white-space: nowrap; }
.hb-btn:disabled { opacity: .5; cursor: default; transform: none !important; box-shadow: none !important; }
.hb-btn:not(:disabled):hover { transform: translateY(-1px); }
.hb-btn-primary { background: linear-gradient(135deg, var(--hb-a), var(--hb-b)); color: #fff;
  box-shadow: 0 3px 10px rgba(37,99,235,.3); }
.hb-btn-primary:not(:disabled):hover { box-shadow: 0 5px 16px rgba(37,99,235,.42); }
.hb-btn-ghost { background: transparent; color: inherit; border-color: var(--hb-line); }
.hb-btn-ghost:not(:disabled):hover { border-color: var(--hb-a); color: var(--hb-a); }

.hb-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4);
  border-top-color: #fff; display: inline-block; vertical-align: -2px; margin-right: 6px; animation: hbSpin .7s linear infinite; }
@keyframes hbSpin { to { transform: rotate(360deg); } }

.hb-check { display: flex; align-items: baseline; gap: 10px; font-size: 13px; line-height: 1.5; }
.hb-dot { width: 16px; height: 16px; border-radius: 50%; flex: none; align-self: center; display: grid; place-items: center;
  font-size: 10px; font-weight: 800; color: #fff; animation: hbPop .25s ease both; }
.hb-dot-ok { background: var(--hb-ok); } .hb-dot-err { background: var(--hb-err); }
@keyframes hbPop { from { transform: scale(.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.hb-check-name { font-weight: 600; flex: none; }
.hb-check-detail { font-size: 12px; color: var(--hb-mut); word-break: break-all; }

.hb-banner { font-size: 12px; line-height: 1.6; border-radius: 9px; padding: 8px 12px; }
.hb-banner-info { color: var(--hb-mut); background: rgba(127,127,127,.08); }
.hb-banner-warn { color: var(--hb-warn); background: rgba(180,83,9,.08); }
.hb-banner-err { color: var(--hb-err); background: rgba(211,47,47,.08); }
.hb-banner-ok { color: var(--hb-ok); background: rgba(21,128,61,.08); font-weight: 600; }

.hb-agents { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.hb-agent { border: 1px solid var(--hb-line); border-radius: 10px; padding: 10px 12px; display: flex; gap: 10px;
  align-items: center; transition: border-color .15s ease; }
.hb-agent:hover { border-color: var(--hb-a); }
.hb-mono { width: 30px; height: 30px; border-radius: 8px; flex: none; display: grid; place-items: center;
  font-size: 11px; font-weight: 800; color: #fff; }
.hb-mono-cc { background: linear-gradient(135deg, #d97706, #b45309); }
.hb-mono-cx { background: linear-gradient(135deg, #0e7490, #155e75); }
.hb-mono-oc { background: linear-gradient(135deg, #7c3aed, #6d28d9); }
.hb-agent-txt { display: flex; flex-direction: column; min-width: 0; }
.hb-agent-name { font-size: 12px; font-weight: 600; }
.hb-agent-n { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }
.hb-agent-n small { font-size: 11px; font-weight: 400; color: var(--hb-mut); margin-left: 3px; }

.hb-bar { height: 8px; border-radius: 999px; background: rgba(127,127,127,.18); overflow: hidden; }
.hb-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--hb-a), var(--hb-b));
  transition: width .4s ease; position: relative; overflow: hidden; }
.hb-bar-fill::after { content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.45), transparent);
  animation: hbShimmer 1.4s ease infinite; }
@keyframes hbShimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.hb-phase { font-size: 12px; color: var(--hb-mut); font-variant-numeric: tabular-nums; display: flex;
  justify-content: space-between; gap: 10px; }

.hb-headline { font-size: 14px; font-weight: 700; line-height: 1.6; }
.hb-headline b { background: linear-gradient(90deg, var(--hb-a), var(--hb-b));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.hb-metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
.hb-metric { border: 1px solid var(--hb-line); border-radius: 10px; padding: 8px 12px; }
.hb-metric-n { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.25; }
.hb-metric-l { font-size: 11px; color: var(--hb-mut); }
.hb-rows { display: flex; flex-direction: column; gap: 6px; }
.hb-row { display: grid; grid-template-columns: 92px 1fr 44px; gap: 10px; align-items: center; font-size: 12px; }
.hb-row-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hb-row-bar { height: 6px; border-radius: 999px; background: linear-gradient(90deg, var(--hb-a), var(--hb-b)); }
.hb-row-n { text-align: right; font-variant-numeric: tabular-nums; color: var(--hb-mut); }
.hb-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.hb-chip { font-size: 11px; border: 1px solid var(--hb-line); border-radius: 999px; padding: 2px 10px;
  color: var(--hb-mut); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.hb-mem-tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.hb-input { flex: 1; min-width: 160px; font-size: 12px; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--hb-line); background: transparent; color: inherit; outline: none; transition: border-color .15s ease; }
.hb-input:focus { border-color: var(--hb-a); }
.hb-fchips { display: flex; flex-wrap: wrap; gap: 5px; }
.hb-fchip { cursor: pointer; font-size: 11px; border-radius: 999px; padding: 2px 10px; border: 1px solid var(--hb-line);
  background: transparent; color: var(--hb-mut); transition: all .12s ease; }
.hb-fchip-on { background: var(--hb-a); border-color: transparent; color: #fff; }
.hb-mem-list { display: flex; flex-direction: column; gap: 7px; max-height: 380px; overflow: auto; padding-right: 2px; }
.hb-mem { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--hb-line); border-radius: 9px;
  padding: 8px 11px; animation: hbIn .28s ease both; }
.hb-mem-type { font-size: 10px; font-weight: 700; border-radius: 5px; padding: 2px 7px; color: #fff; flex: none; margin-top: 1px; }
.hb-t-preference { background: #7c3aed; } .hb-t-decision { background: var(--hb-a); }
.hb-t-lesson { background: var(--hb-warn); } .hb-t-fact { background: #0e7490; } .hb-t-unknown { background: #6b7280; }
.hb-mem-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.hb-mem-text { font-size: 12.5px; line-height: 1.55; word-break: break-word; display: -webkit-box;
  -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.hb-mem-meta { font-size: 10.5px; color: var(--hb-mut); display: flex; gap: 8px; flex-wrap: wrap; }
.hb-mem-more { align-self: center; }
.hb-mem-del { cursor: pointer; border: 1px solid transparent; background: transparent; color: var(--hb-mut);
  border-radius: 6px; font-size: 13px; padding: 1px 7px; flex: none; transition: all .12s ease; }
.hb-mem-del:hover { color: var(--hb-err); border-color: rgba(217,48,37,.4); }
.hb-mem-del-confirm { color: #fff; background: var(--hb-err); border-color: transparent; }
.hb-mem-edit { cursor: pointer; border: none; background: transparent; color: var(--hb-mut); font-size: 11px;
  padding: 1px 6px; flex: none; }
.hb-mem-edit:hover { color: var(--hb-a); }
.hb-mem-editor { width: 100%; font: inherit; font-size: 12.5px; line-height: 1.55; border-radius: 8px;
  border: 1px solid var(--hb-a); background: transparent; color: inherit; padding: 6px 9px; outline: none; resize: vertical; }
.hb-mem-actions { display: flex; gap: 6px; }
.hb-mini { cursor: pointer; border-radius: 7px; font-size: 11.5px; padding: 4px 12px; border: 1px solid var(--hb-line);
  background: transparent; color: inherit; }
.hb-mini-pri { background: var(--hb-a); border-color: transparent; color: #fff; }
.hb-pre { white-space: pre-wrap; font-size: 11px; max-height: 220px; overflow: auto; background: rgba(0,0,0,.07);
  padding: 10px; border-radius: 8px; line-height: 1.6; }

@media (prefers-reduced-motion: reduce) {
  .hb-card, .hb-dot, .hb-bar-fill::after { animation: none !important; }
  .hb-bar-fill, .hb-btn { transition: none !important; }
}
`

// ---------------------------------------------------------------------------
// 数据获取
// ---------------------------------------------------------------------------

async function getJson<T extends object>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = await res.json() as T | { error: string }
  if (!res.ok || 'error' in body) throw new Error('error' in body ? body.error : `HTTP ${res.status}`)
  return body
}

async function postJson<T extends object>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json() as T | { error: string }
  if (!res.ok || 'error' in data) throw new Error('error' in data ? data.error : `HTTP ${res.status}`)
  return data
}

/** 任务快照可为 null（尚未跑过任何迁移）。 */
async function getJob(): Promise<ImportJob | null> {
  const res = await fetch('/dsh-hippo/import', { cache: 'no-store' })
  if (!res.ok) return null
  const body: unknown = await res.json()
  return body !== null && typeof body === 'object' && !('error' in body) ? body as ImportJob : null
}

// ---------------------------------------------------------------------------
// 展示件
// ---------------------------------------------------------------------------

const AGENT_META: Record<string, { label: string; mono: string; cls: string }> = {
  'claude-code': { label: 'Claude Code', mono: 'CC', cls: 'hb-mono-cc' },
  codex: { label: 'Codex', mono: 'CX', cls: 'hb-mono-cx' },
  opencode: { label: 'opencode', mono: 'OC', cls: 'hb-mono-oc' },
}

function DoctorCard({ report }: { report: DoctorReport }): ReturnType<typeof createElement> {
  return createElement('div', { className: 'hb-card' },
    createElement('div', { className: 'hb-row', style: { gridTemplateColumns: '1fr', marginBottom: '-2px' } },
      createElement('div', { className: 'hb-banner hb-banner-ok', style: { display: report.ok ? 'block' : 'none' } },
        '环境就绪，可以开始迁移'),
      createElement('div', { className: 'hb-banner hb-banner-warn', style: { display: report.ok ? 'none' : 'block' } },
        '环境不完整，按下方指引处理后再迁移'),
    ),
    ...report.checks.map((c, i) =>
      createElement('div', { key: i, className: 'hb-check' },
        createElement('span', { className: `hb-dot ${c.ok ? 'hb-dot-ok' : 'hb-dot-err'}`, style: { animationDelay: `${i * 60}ms` } }, c.ok ? '✓' : '✕'),
        createElement('span', { className: 'hb-check-name' }, c.name),
        createElement('span', { className: 'hb-check-detail' }, c.detail),
      ),
    ),
    createElement('div', { className: 'hb-banner hb-banner-info' }, `💡 ${report.modelNote}`),
    ...report.guidance.map((g, i) => createElement('div', { key: 'g' + i, className: 'hb-banner hb-banner-warn' }, g)),
  )
}

function AgentsCard({ inv }: { inv: AgentInventory[] }): ReturnType<typeof createElement> {
  const total = inv.reduce((n, a) => n + a.sessions, 0)
  return createElement('div', { className: 'hb-card' },
    createElement('div', { className: 'hb-hero' },
      createElement('span', { style: { fontWeight: 700, fontSize: 13 } }, '会话发现'),
      createElement('span', { className: 'hb-sub' }, total > 0 ? `共 ${total} 个会话可迁移` : '未发现任何 agent 会话'),
    ),
    createElement('div', { className: 'hb-agents' },
      ...inv.map((a) => {
        const meta = AGENT_META[a.agent] ?? { label: a.agent, mono: a.agent.slice(0, 2).toUpperCase(), cls: '' }
        return createElement('div', { key: a.agent, className: 'hb-agent', title: a.root },
          createElement('span', { className: `hb-mono ${meta.cls}` }, meta.mono),
          createElement('span', { className: 'hb-agent-txt' },
            createElement('span', { className: 'hb-agent-name' }, meta.label),
            createElement('span', { className: 'hb-agent-n' }, a.sessions, createElement('small', null, '会话')),
          ),
        )
      }),
    ),
  )
}

function ProgressCard({ job }: { job: ImportJob }): ReturnType<typeof createElement> {
  const pct = job.total > 0 ? Math.round((job.current / job.total) * 100) : 0
  return createElement('div', { className: 'hb-card' },
    createElement('div', { className: 'hb-phase' },
      createElement('span', null, job.phase !== '' ? job.phase : `正在迁移 ${AGENT_META[job.agent]?.label ?? job.agent} 会话`),
      createElement('span', null, `${job.current} / ${job.total} · ${pct}%`),
    ),
    createElement('div', { className: 'hb-bar' },
      createElement('div', { className: 'hb-bar-fill', style: { width: `${Math.max(pct, 4)}%` } }),
    ),
  )
}

function StatsCard({ job }: { job: ImportJob }): ReturnType<typeof createElement> {
  const s = job.stats
  const secs = s.finishedAt ? Math.max(1, Math.round((s.finishedAt - s.startedAt) / 1000)) : null
  const maxAgent = Math.max(1, ...s.byAgent.map((a) => a.created))
  const maxProj = Math.max(1, ...s.projects.map((p) => p.memories))
  return createElement('div', { className: 'hb-card' },
    createElement('div', { className: 'hb-headline' },
      s.dryRun
        ? ['预览完成：从 ', createElement('b', { key: 'n' }, s.sessionsScanned), ' 个会话识别出 ', createElement('b', { key: 'm' }, s.created), ' 条候选记忆，覆盖 ', createElement('b', { key: 'p' }, s.projects.length), ' 个项目（未写入）']
        : ['迁移完成：从 ', createElement('b', { key: 'n' }, s.sessionsScanned), ' 个会话提炼出 ', createElement('b', { key: 'm' }, s.created), ' 条新记忆，覆盖 ', createElement('b', { key: 'p' }, s.projects.length), ' 个项目'],
    ),
    createElement('div', { className: 'hb-metrics' },
      ...([
        ['新建', s.created, ''], ['强化', s.reinforced, ''], ['待复核', s.maybe, ''], ['跳过', s.skipped, ''],
      ] as [string, number, string][]).map(([l, n]) =>
        createElement('div', { key: l, className: 'hb-metric' },
          createElement('div', { className: 'hb-metric-n' }, n),
          createElement('div', { className: 'hb-metric-l' }, l),
        ),
      ),
    ),
    s.byAgent.length > 0
      ? createElement('div', { className: 'hb-rows' },
          ...s.byAgent.map((a) =>
            createElement('div', { key: a.agent, className: 'hb-row' },
              createElement('span', { className: 'hb-row-name' }, AGENT_META[a.agent]?.label ?? a.agent),
              createElement('span', { className: 'hb-row-bar', style: { width: `${Math.max(4, (a.created / maxAgent) * 100)}%` } }),
              createElement('span', { className: 'hb-row-n' }, a.created),
            ),
          ),
        )
      : null,
    s.projects.length > 0
      ? createElement('div', { className: 'hb-chips' },
          ...s.projects.map((p) =>
            createElement('span', { key: p.name, className: 'hb-chip', title: `${p.name} · ${p.memories} 条` },
              `${p.name.split(/[\\/]/).pop() ?? p.name} · ${p.memories}`),
          ),
        )
      : null,
    s.maybe > 0
      ? createElement('div', { className: 'hb-banner hb-banner-warn' },
          `${s.maybe} 条近似重复进入「待复核」档（相似度 0.80–0.93），未自动合并——H3 将提供人工确认入口。`)
      : null,
    secs !== null
      ? createElement('div', { className: 'hb-banner hb-banner-info' },
          `耗时 ${secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`} · 候选 ${s.candidatesExtracted} 条 · 有产出的会话 ${s.sessionsWithCandidates} 个`
          + `${s.sessionsSkippedUnchanged > 0 ? ` · 增量跳过 ${s.sessionsSkippedUnchanged} 个未变更` : ''}`
          + `${s.sessionsExcluded > 0 ? ` · 排除 ${s.sessionsExcluded} 个（.hippoignore）` : ''}`
          + `${s.parseErrors > 0 ? ` · ${s.parseErrors} 个文件解析失败（已跳过）` : ''}`)
      : null,
  )
}

// ---------------------------------------------------------------------------
// 记忆库浏览
// ---------------------------------------------------------------------------

const TYPE_META: Record<string, { label: string; cls: string }> = {
  preference: { label: '偏好', cls: 'hb-t-preference' },
  decision: { label: '决策', cls: 'hb-t-decision' },
  lesson: { label: '教训', cls: 'hb-t-lesson' },
  fact: { label: '事实', cls: 'hb-t-fact' },
}

function fmtAgent(agent: string): string {
  const short = agent.replace(/^import:/, '')
  return AGENT_META[short]?.label ?? (short === '' ? '手工' : short)
}

function fmtDate(ms: number): string {
  if (ms <= 0) return ''
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function MemRow({ m, onDelete, onUpdate }: {
  m: MemoryItem
  onDelete: (id: string) => Promise<void>
  onUpdate: (id: string, text: string) => Promise<void>
}): ReturnType<typeof createElement> {
  const t = TYPE_META[m.type] ?? { label: m.type || '未分类', cls: 'hb-t-unknown' }
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.text)
  const [saving, setSaving] = useState(false)

  return createElement('div', { className: 'hb-mem' },
    createElement('span', { className: `hb-mem-type ${t.cls}` }, t.label),
    createElement('span', { className: 'hb-mem-body' },
      editing
        ? createElement('span', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            createElement('textarea', { className: 'hb-mem-editor', rows: 3, value: draft,
              onChange: (e: { target: { value: string } }) => { setDraft(e.target.value) } }),
            createElement('span', { className: 'hb-mem-actions' },
              createElement('button', { className: 'hb-mini hb-mini-pri', disabled: saving || draft.trim() === '',
                onClick: async () => { setSaving(true); await onUpdate(m.id, draft.trim()); setSaving(false); setEditing(false) } }, saving ? '保存中…' : '保存'),
              createElement('button', { className: 'hb-mini', onClick: () => { setDraft(m.text); setEditing(false) } }, '取消'),
            ),
          )
        : createElement('span', { className: 'hb-mem-text' }, m.text),
      createElement('span', { className: 'hb-mem-meta' },
        createElement('span', null, m.project === 'global' ? '全局' : m.project),
        createElement('span', null, `来源 ${fmtAgent(m.agent)}`),
        m.createdAt > 0 ? createElement('span', null, fmtDate(m.createdAt)) : null,
        m.strength > 1 ? createElement('span', null, `强度 ${m.strength}`) : null,
        createElement('button', { className: 'hb-mem-edit', onClick: () => { setEditing(true) } }, '编辑'),
        createElement('button', {
          className: `hb-mem-del${confirming ? ' hb-mem-del-confirm' : ''}`,
          onClick: () => {
            if (!confirming) { setConfirming(true); setTimeout(() => { setConfirming(false) }, 3000); return }
            void onDelete(m.id)
          },
        }, confirming ? '确认删除' : '×'),
      ),
    ),
  )
}

function MemoriesCard({ page, loading, q, setQ, type, setType, onSearch, onMore, onRefresh }: {
  page: MemoryPage | null
  loading: boolean
  q: string
  setQ: (v: string) => void
  type: string
  setType: (v: string) => void
  onSearch: () => void
  onMore: () => void
  onRefresh: () => void
}): ReturnType<typeof createElement> {
  const isSearch = q.trim() !== ''
  const shown = page?.items ?? []
  const hasMore = page !== null && !isSearch && page.offset + page.items.length < page.total

  // H3 编译区
  const [compileOpen, setCompileOpen] = useState(false)
  const [compiling, setCompiling] = useState(false)
  const [compileResult, setCompileResult] = useState<{ memoryCount: number; markdown: string; written?: string[] } | null>(null)
  const [compProject, setCompProject] = useState('')
  const [compPath, setCompPath] = useState('')
  const [compMsg, setCompMsg] = useState<string | null>(null)

  const doCompile = async (write: boolean) => {
    if (compiling) return
    setCompiling(true)
    setCompMsg(null)
    try {
      const r = await postJson<{ memoryCount: number; markdown: string; written?: string[] }>('/dsh-hippo/memories/compile',
        { project: compProject.trim() === '' ? undefined : compProject.trim(), write, outPath: compPath.trim() === '' ? undefined : compPath.trim() })
      setCompileResult(r)
      if (write && r.written) setCompMsg(`已写入：${r.written.join('、')}`)
    } catch (e) {
      setCompMsg(`编译失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setCompiling(false)
  }

  return createElement('div', { className: 'hb-card' },
    createElement('div', { className: 'hb-hero' },
      createElement('span', { style: { fontWeight: 700, fontSize: 13 } }, '记忆库'),
      createElement('span', { className: 'hb-sub' },
        page === null ? (loading ? '读取中…' : '') : isSearch ? `搜索到 ${page.total} 条` : `共 ${page.total} 条记忆`),
      createElement('span', { className: 'hb-spacer' }),
      createElement('button', { className: 'hb-btn hb-btn-ghost', style: { padding: '4px 12px', fontSize: 12 },
        onClick: () => { setCompileOpen(!compileOpen) } }, compileOpen ? '收起编译' : '编译 AGENTS.md'),
    ),
    compileOpen
      ? createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          createElement('div', { className: 'hb-mem-tools' },
            createElement('input', { className: 'hb-input', placeholder: '项目名（留空=全部项目）', value: compProject,
              onChange: (e: { target: { value: string } }) => { setCompProject(e.target.value) } }),
            createElement('input', { className: 'hb-input', placeholder: '写入路径（留空=预览不落盘；如 D:\\coding\\proj\\AGENTS.md）', value: compPath,
              onChange: (e: { target: { value: string } }) => { setCompPath(e.target.value) } }),
          ),
          createElement('div', { className: 'hb-mem-actions' },
            createElement('button', { className: 'hb-mini', disabled: compiling, onClick: () => { void doCompile(false) } }, compiling ? '编译中…' : '预览'),
            createElement('button', { className: 'hb-mini hb-mini-pri', disabled: compiling || compPath.trim() === '', onClick: () => { void doCompile(true) } }, '写入文件'),
          ),
          compMsg !== null ? createElement('div', { className: 'hb-banner hb-banner-info' }, compMsg) : null,
          compileResult !== null
            ? createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                createElement('div', { className: 'hb-muted' }, `入选记忆 ${compileResult.memoryCount} 条`),
                createElement('pre', { className: 'hb-pre' }, compileResult.markdown.slice(0, 4000) || '（空）'),
              )
            : null,
        )
      : null,
    createElement('div', { className: 'hb-mem-tools' },
      createElement('input', {
        className: 'hb-input',
        placeholder: '语义搜索记忆…',
        value: q,
        onChange: (e: { target: { value: string } }) => { setQ(e.target.value) },
        onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') onSearch() },
      }),
      createElement('button', { className: 'hb-btn hb-btn-ghost', onClick: onSearch, disabled: loading },
        loading && page !== null && isSearch ? '搜索中…' : '搜索'),
    ),
    createElement('div', { className: 'hb-fchips' },
      ...[['', '全部'], ['preference', '偏好'], ['decision', '决策'], ['lesson', '教训'], ['fact', '事实']].map(([val, label]) =>
        createElement('button', {
          key: val,
          className: `hb-fchip${type === val ? ' hb-fchip-on' : ''}`,
          onClick: () => { setType(val) },
        }, label),
      ),
    ),
    shown.length > 0
      ? createElement('div', { className: 'hb-mem-list' },
          ...shown.map((m) => createElement(MemRow, {
            key: m.id, m,
            onDelete: async (id: string) => {
              try {
                await postJson<{ ok: boolean }>('/dsh-hippo/memories/forget', { id })
                onRefresh()
              } catch (e) {
                window.alert?.(`删除失败：${e instanceof Error ? e.message : String(e)}`)
              }
            },
            onUpdate: async (id: string, text: string) => {
              await postJson<{ status: string }>('/dsh-hippo/memories/update', { id, text })
              onRefresh()
            },
          })))
      : !loading
        ? createElement('div', { className: 'hb-banner hb-banner-info' },
            isSearch ? '没有匹配的记忆，换个关键词试试。' : '记忆库还是空的——用上面的「开始迁移」把会话蒸馏进来。')
        : null,
    hasMore
      ? createElement('button', { className: 'hb-btn hb-btn-ghost hb-mem-more', onClick: onMore, disabled: loading }, '加载更多')
      : null,
  )
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

function Panel(): ReturnType<typeof createElement> {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [inv, setInv] = useState<AgentInventory[] | null>(null)
  const [job, setJob] = useState<ImportJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'none' | 'doctor' | 'preview' | 'import'>('none')
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  // 记忆库浏览状态
  const [mem, setMem] = useState<MemoryPage | null>(null)
  const [memLoading, setMemLoading] = useState(false)
  const [memQ, setMemQ] = useState('')
  const [memQApplied, setMemQApplied] = useState('')
  const [memType, setMemType] = useState('')
  const memOffset = useRef(0)

  const fetchMem = async (opts: { q: string; type: string; offset: number; append: boolean }) => {
    setMemLoading(true)
    try {
      const params = new URLSearchParams({ limit: '30', offset: String(opts.offset) })
      if (opts.q.trim() !== '') params.set('q', opts.q.trim())
      if (opts.type !== '') params.set('type', opts.type)
      const page = await getJson<MemoryPage>(`/dsh-hippo/memories?${params.toString()}`)
      setMem((prev) => (opts.append && prev !== null ? { ...page, items: [...prev.items, ...page.items] } : page))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setMemLoading(false)
  }

  const poll = (running: boolean) => {
    if (timer.current !== null) { clearInterval(timer.current); timer.current = null }
    if (!running) return
    timer.current = setInterval(() => {
      void getJob().then(
        (j) => {
          if (j === null) return
          setJob(j)
          if (j.state !== 'running') {
            poll(false)
            setBusy('none')
            void getJson<AgentInventory[]>('/dsh-hippo/inventory').then(setInv).catch(() => {})
            if (!j.stats.dryRun) {
              memOffset.current = 0
              void fetchMem({ q: '', type: memType, offset: 0, append: false })
            }
          }
        },
        () => {},
      )
    }, 1200)
  }

  const runDoctor = async () => {
    if (busy !== 'none') return
    setBusy('doctor')
    setError(null)
    try {
      const [r, i] = await Promise.all([
        getJson<DoctorReport>('/dsh-hippo/doctor'),
        getJson<AgentInventory[]>('/dsh-hippo/inventory'),
      ])
      setReport(r)
      setInv(i)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy('none')
  }

  const start = async (dryRun: boolean) => {
    if (busy !== 'none') return
    setBusy(dryRun ? 'preview' : 'import')
    setError(null)
    try {
      const j = await postJson<ImportJob>('/dsh-hippo/import', { dryRun })
      setJob(j)
      poll(j.state === 'running')
      if (j.state !== 'running') setBusy('none')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy('none')
    }
  }

  useEffect(() => {
    void runDoctor()
    void getJob().then((j) => {
      if (j !== null && j.state === 'running') { setJob(j); poll(true) }
    }).catch(() => {})
    void fetchMem({ q: '', type: '', offset: 0, append: false })
    return () => { if (timer.current !== null) clearInterval(timer.current) }
  }, [])

  // 类型筛选变化时重查（搜索词保持已应用值）
  useEffect(() => {
    if (report === null) return
    memOffset.current = 0
    void fetchMem({ q: memQApplied, type: memType, offset: 0, append: false })
  }, [memType])

  const ready = report !== null && report.migrationReady
  const hasSessions = (inv ?? []).some((a) => a.sessions > 0)

  return createElement('div', { className: 'hb-panel' },
    createElement('style', null, CSS),

    createElement('div', { className: 'hb-card' },
      createElement('button', {
        className: 'hb-btn hb-btn-ghost', style: { alignSelf: 'flex-end', fontSize: 12 },
        onClick: overlayStore.toggle,
        title: '打开独立记忆面板（不占设置页空间）',
      }, '🦛 在独立面板中打开'),
      createElement('div', { className: 'hb-hero' },
        createElement('span', { className: 'hb-logo' }, '桥'),
        createElement('span', { className: 'hb-hero-txt' },
          createElement('span', { className: 'hb-title' }, '记忆桥', createElement('span', { className: 'hb-beta' }, '迁移引擎 beta')),
          createElement('span', { className: 'hb-sub' }, '把 Claude Code / Codex / opencode 会话里积累的记忆蒸馏进 dsh——开局即认识你的项目与偏好'),
        ),
        createElement('span', { className: 'hb-spacer' }),
        createElement('button', { className: 'hb-btn hb-btn-ghost', onClick: runDoctor, disabled: busy !== 'none' },
          busy === 'doctor' ? '自检中…' : '重新自检'),
      ),
      error !== null ? createElement('div', { className: 'hb-banner hb-banner-err' }, error) : null,
    ),

    report !== null ? createElement(DoctorCard, { report }) : null,
    inv !== null ? createElement(AgentsCard, { inv }) : null,

    createElement('div', { className: 'hb-card' },
      createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
        createElement('button', {
          className: 'hb-btn hb-btn-primary', onClick: () => { void start(false) },
          disabled: busy !== 'none' || !ready || !hasSessions,
        }, busy === 'import' ? createElement('span', { className: 'hb-spin' }) : null, busy === 'import' ? '迁移中…' : '开始迁移'),
        createElement('button', {
          className: 'hb-btn hb-btn-ghost', onClick: () => { void start(true) },
          disabled: busy !== 'none' || !ready || !hasSessions,
        }, busy === 'preview' ? '预览中…' : '预览（不写入）'),
        !ready && report !== null
          ? createElement('span', { className: 'hb-sub' }, '环境自检未通过，暂不可迁移')
          : !hasSessions && inv !== null
            ? createElement('span', { className: 'hb-sub' }, '未发现可迁移的会话')
            : null,
      ),
    ),

    job !== null && job.state === 'running' ? createElement(ProgressCard, { job }) : null,
    job !== null && job.state === 'done' ? createElement(StatsCard, { job }) : null,
    job !== null && job.state === 'error'
      ? createElement('div', { className: 'hb-card' }, createElement('div', { className: 'hb-banner hb-banner-err' }, `迁移失败：${job.error ?? '未知错误'}`))
      : null,

    createElement(MemoriesCard, {
      page: mem,
      loading: memLoading,
      q: memQ,
      setQ: setMemQ,
      type: memType,
      setType: setMemType,
      onSearch: () => {
        memOffset.current = 0
        setMemQApplied(memQ)
        void fetchMem({ q: memQ, type: memType, offset: 0, append: false })
      },
      onMore: () => {
        memOffset.current += 30
        void fetchMem({ q: memQApplied, type: memType, offset: memOffset.current, append: true })
      },
      onRefresh: () => {
        memOffset.current = 0
        void fetchMem({ q: memQApplied, type: memType, offset: 0, append: false })
      },
    }),
  )
}

/** 自动蒸馏状态卡：模式 + 立即扫描 + 待复核队列（设置页与浮层共用）。 */
function AutoCard(): ReturnType<typeof createElement> {
  const [st, setSt] = useState<AutoStatus | null>(null)
  const [queue, setQueue] = useState<ShelvedItem[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  const reload = (): void => {
    void getJson<AutoStatus>('/dsh-hippo/auto').then(setSt).catch(() => {})
    void getJson<ShelvedItem[]>('/dsh-hippo/shelved').then(setQueue).catch(() => { setQueue([]) })
  }
  useEffect(reload, [])
  useEffect(() => {
    if (toast === '') return
    const t = setTimeout(() => { setToast('') }, 3000)
    return () => { clearTimeout(t) }
  }, [toast])

  const save = (patch: Record<string, unknown>): void => {
    setBusy(true)
    void postJson<AutoStatus>('/dsh-hippo/auto', { settings: patch })
      .then(() => { setToast('已保存，下一轮扫描生效'); reload() })
      .catch((e: unknown) => { setToast(e instanceof Error ? e.message : String(e)) })
      .finally(() => { setBusy(false) })
  }
  const runNow = (): void => {
    setBusy(true)
    void postJson<{ scanned: number; created: number; reinforced: number; shelved: number }>('/dsh-hippo/auto/run', {})
      .then((r) => { setToast(`扫描 ${r.scanned} · 新增 ${r.created} · 强化 ${r.reinforced} · 待审 +${r.shelved}`); reload() })
      .catch((e: unknown) => { setToast(e instanceof Error ? e.message : String(e)) })
      .finally(() => { setBusy(false) })
  }
  const queueAct = (action: 'apply' | 'discard', indices: number[]): void => {
    if (indices.length === 0) return
    setBusy(true)
    void postJson<Record<string, number>>('/dsh-hippo/shelved', { action, indices })
      .then((r) => {
        setToast(action === 'apply' ? `入库：新建 ${r.created ?? 0} · 强化 ${r.reinforced ?? 0}` : `丢弃 ${indices.length} 条`)
        setPicked(new Set()); reload()
      })
      .catch((e: unknown) => { setToast(e instanceof Error ? e.message : String(e)) })
      .finally(() => { setBusy(false) })
  }

  const modeLabel: Record<string, string> = { off: '关闭', review: '全进待审', auto: '自动入库' }
  return createElement('div', { className: 'hb-card' },
    createElement('div', { className: 'hb-title' }, '自动蒸馏',
      createElement('span', { className: 'hb-beta' }, st !== null ? modeLabel[st.settings.mode] : '…'),
      createElement('span', { className: 'hb-spacer' }),
      createElement('button', { className: 'hb-btn hb-btn-ghost', disabled: busy, onClick: runNow }, busy ? '…' : '立即扫描')),
    st !== null && createElement('div', { className: 'hb-banner hb-banner-info' },
      `置信度 ≥ ${st.settings.threshold.toFixed(2)} · 间隔 ${st.settings.intervalMin} 分钟` +
      (st.settings.lastRun != null ? ` · 上轮：扫 ${st.settings.lastRun.scanned}、入库 ${st.settings.lastRun.created}、待审 +${st.settings.lastRun.shelved}` : '')),
    createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
      ...(['off', 'review', 'auto'] as const).map((m) =>
        createElement('button', {
          key: m, className: 'hb-btn hb-btn-ghost', disabled: busy,
          style: st?.settings.mode === m ? { borderColor: 'var(--hb-a)', color: 'var(--hb-a)' } : undefined,
          onClick: () => { save({ mode: m }) },
        }, modeLabel[m]))),
    toast !== '' && createElement('div', { className: 'hb-banner hb-banner-ok' }, toast),
    createElement('div', { className: 'hb-title', style: { fontSize: 13 } }, '待复核队列',
      createElement('span', { className: 'hb-beta' }, String(queue.length)),
      createElement('span', { className: 'hb-spacer' }),
      createElement('button', { className: 'hb-btn hb-btn-ghost', disabled: busy || picked.size === 0, onClick: () => { queueAct('apply', [...picked]) } }, `入库所选（${picked.size}）`),
      createElement('button', { className: 'hb-btn hb-btn-ghost', disabled: busy || queue.length === 0, onClick: () => { queueAct('discard', queue.map((q) => q.index)) } }, '清空')),
    queue.length === 0
      ? createElement('div', { className: 'hb-banner hb-banner-info' }, '队列为空——maybe 带与低置信候选会出现在这里，不会丢失。')
      : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' } },
          ...queue.map((item) => createElement('label', {
            key: item.index,
            style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '4px 6px', borderRadius: 8, border: '1px solid var(--hb-line)', cursor: 'pointer' },
          },
            createElement('input', {
              type: 'checkbox', checked: picked.has(item.index),
              onChange: () => {
                setPicked((prev) => {
                  const next = new Set(prev)
                  if (next.has(item.index)) next.delete(item.index); else next.add(item.index)
                  return next
                })
              },
            }),
            createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.text),
            createElement('span', { style: { fontSize: 11, color: 'var(--hb-mut)', flex: 'none' } }, `${item.reason} · ${item.confidence.toFixed(2)}`),
            createElement('button', {
              className: 'hb-btn hb-btn-ghost', style: { padding: '2px 8px', fontSize: 11 }, disabled: busy,
              onClick: (e: Event) => { e.preventDefault(); e.stopPropagation(); queueAct('discard', [item.index]) },
            }, '✕')))),
  )
}

/** 侧栏脚部入口：设置旁的河马图标（wide=带文字行，rail=纯图标）。 */
function FooterMemoryButton({ wide }: { wide: boolean }): ReturnType<typeof createElement> {
  return createElement('button', {
    title: '记忆面板（hippo）', onClick: overlayStore.toggle,
    style: {
      display: 'flex', alignItems: 'center', gap: wide ? 8 : 0, justifyContent: 'center',
      cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit',
      padding: wide ? '6px 10px' : '8px', borderRadius: 8, fontSize: 12, width: '100%',
    },
  },
    createElement('span', { style: { fontSize: 16, lineHeight: 1 } }, '🦛'),
    wide && createElement('span', null, '记忆'),
  )
}

/** shell.overlay 条目：独立浮层（Esc / 点背景关闭；内容=AutoCard + 设置页同一 Panel）。 */
function MemoryOverlay(): ReturnType<typeof createElement> | null {
  const open = useSyncExternalStore(overlayStore.subscribe, () => overlayStore.open)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') overlayStore.close() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open])
  if (!open) return null
  return createElement('div', {
    style: {
      position: 'fixed', inset: 0, zIndex: 90, pointerEvents: 'auto',
      background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    },
    onPointerDown: (e: React.PointerEvent) => { if (e.target === e.currentTarget) overlayStore.close() },
  },
    createElement('div', {
      style: {
        width: 'min(920px, 100%)', maxHeight: '86vh', overflowY: 'auto',
        background: 'var(--bg, #fff)', borderRadius: 16, padding: 20,
        boxShadow: '0 24px 64px rgba(0,0,0,.35)',
      },
      onPointerDown: (e: React.PointerEvent) => { e.stopPropagation() },
    },
      createElement('div', { className: 'hb-panel' },
        createElement('div', { className: 'hb-hero' },
          createElement('div', { className: 'hb-logo' }, 'H'),
          createElement('div', { className: 'hb-hero-txt' },
            createElement('div', { className: 'hb-title' }, '记忆面板 🦛'),
            createElement('div', { className: 'hb-sub' }, 'hippo · 本地优先 · 独立浮层')),
          createElement('span', { className: 'hb-spacer' }),
          createElement('button', { className: 'hb-btn hb-btn-ghost', onClick: overlayStore.close }, '关闭 ✕')),
        createElement(AutoCard, null),
        createElement(Panel, null))))
}

export function apply(ctx: ClientContext): void {
  // 设置页保留（轻入口）；主入口=侧栏脚部河马图标 → 独立浮层（不与其他插件挤位）
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'memory-bridge', order: 41, label: '记忆桥' },
    () => createElement(Panel),
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'hippo-memory-overlay', order: 50 },
    () => createElement(MemoryOverlay),
  ))
}
