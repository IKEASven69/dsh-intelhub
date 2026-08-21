/**
 * dsh-hippo 浏览器半：设置页「记忆桥」。
 * 数据通路走同源 fetch 直连 host 路由（dshmarket 第三方先例，免去构建期
 * 生成 typert 契约）。H0：doctor 自检结果 + 指引展示；H1 起追加 import
 * 按钮与迁移统计，H3 起追加搜索/列表/forget 与「编译 AGENTS.md」。
 * @module dsh-hippo/client
 */

import { createElement, useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DoctorReport } from './types.ts'

export const inject = ['slots']

const CSS = `
.hb-panel { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
.hb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.hb-title { font-weight: 700; font-size: 14px; }
.hb-beta { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #b45309; color: #b45309; }
.hb-run { cursor: pointer; border: none; background: var(--accent, #2563eb); color: #fff; border-radius: 6px; padding: 6px 14px; font-size: 13px; white-space: nowrap; }
.hb-run:disabled { opacity: .55; cursor: default; }
.hb-box { border: 1px solid var(--border, rgba(128,128,128,.35)); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.hb-box-error { border-color: rgba(217,48,37,.5); }
.hb-check { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
.hb-check-name { font-weight: 600; flex: none; }
.hb-check-detail { font-size: 12px; color: var(--muted, rgba(128,128,128,.9)); word-break: break-all; }
.hb-muted { font-size: 12px; color: var(--muted, rgba(128,128,128,.9)); word-break: break-all; }
.hb-guide { font-size: 12px; color: #b45309; }
`

async function fetchDoctor(): Promise<DoctorReport> {
  const res = await fetch('/dsh-hippo/doctor', { cache: 'no-store' })
  const body = await res.json() as DoctorReport | { error: string }
  if (!res.ok || 'error' in body) {
    throw new Error('error' in body ? body.error : `HTTP ${res.status}`)
  }
  return body
}

function Panel(): ReturnType<typeof createElement> {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (running) return
    setRunning(true)
    setError(null)
    try {
      setReport(await fetchDoctor())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setRunning(false)
  }

  useEffect(() => { void run() }, [])

  return createElement('div', { className: 'hb-panel' },
    createElement('style', null, CSS),
    createElement('div', { className: 'hb-head' },
      createElement('span', { className: 'hb-title' }, '记忆桥（跨 agent 记忆迁移）'),
      createElement('span', { className: 'hb-beta' }, '迁移引擎 beta'),
    ),
    createElement('div', { className: 'hb-head' },
      createElement('span', { className: 'hb-muted' }, '把 Claude Code / Codex / opencode 会话里积累的记忆蒸馏进 dsh。'),
      createElement('button', { className: 'hb-run', onClick: run, disabled: running }, running ? '自检中…' : '重新自检'),
    ),
    error !== null ? createElement('div', { className: 'hb-box hb-box-error' }, error) : null,
    report !== null
      ? createElement('div', { className: `hb-box${report.ok ? '' : ' hb-box-error'}` },
          ...report.checks.map((c, i) =>
            createElement('div', { key: i, className: 'hb-check' },
              createElement('span', null, c.ok ? '✅' : '❌'),
              createElement('span', { className: 'hb-check-name' }, c.name),
              createElement('span', { className: 'hb-check-detail' }, c.detail),
            ),
          ),
          createElement('div', { className: 'hb-muted' }, report.modelNote),
          ...report.guidance.map((g, i) => createElement('div', { key: 'g' + i, className: 'hb-guide' }, g)),
        )
      : null,
  )
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'memory-bridge', order: 41, label: '记忆桥' },
    () => createElement(Panel),
  ))
}
