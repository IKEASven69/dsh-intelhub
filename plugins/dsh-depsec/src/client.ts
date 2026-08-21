/**
 * dsh-depsec 浏览器半：设置页「依赖安全审计」。
 * 四模式 + 判定横幅 + 危险度筛选 + 点击跳转源文件 + 一键修复 + SARIF 导出 + 监控状态。
 * @module dsh-depsec/client
 */

import { createElement, useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { DepsecResult } from './types.ts'

export const inject = ['slots']

/** 直连宿主 /api HTTP 桥(Connection 信封)。本地验证构建不依赖 typert 生成的
 * remote 契约;正式构建可用 dsh-api-remotes 的 ctx.remote.depsec 服务替换。 */
async function rpc<T>(method: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: T; error: { message: string } }> {
  try {
    const res = await fetch(`/api/depsec/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: (globalThis.crypto?.randomUUID?.() ?? String(Date.now() + Math.random())),
        method: `depsec/${method}`,
        payload: { args },
      }),
    })
    const msg = await res.json() as { type: string; result?: { ok: boolean; value?: T; error?: { message?: string } } }
    if (msg.result !== undefined && msg.result.ok) return { ok: true, value: msg.result.value }
    return { ok: false, error: { message: msg.result?.error?.message ?? `HTTP ${res.status}` } }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : String(e) } }
  }
}

const CSS = `
.da-panel { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
.da-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.da-title { font-weight: 700; font-size: 14px; }
.da-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.da-tab { cursor: pointer; border: 1px solid var(--border, rgba(128,128,128,.4)); background: transparent; color: inherit; border-radius: 6px; padding: 4px 10px; font-size: 12px; }
.da-tab-on { background: var(--accent, #2563eb); color: #fff; border-color: transparent; }
.da-input { flex: 1; min-width: 0; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border, rgba(128,128,128,.4)); background: transparent; color: inherit; }
.da-run { cursor: pointer; border: none; background: var(--accent, #2563eb); color: #fff; border-radius: 6px; padding: 6px 14px; font-size: 13px; white-space: nowrap; }
.da-run:disabled { opacity: .55; cursor: default; }
.da-fix { cursor: pointer; border: 1px solid #15803d; background: transparent; color: #15803d; border-radius: 6px; padding: 4px 12px; font-size: 12px; }
.da-export { cursor: pointer; border: 1px solid var(--border, rgba(128,128,128,.5)); background: transparent; color: inherit; border-radius: 6px; padding: 4px 10px; font-size: 12px; }
.da-hint { font-size: 12px; color: var(--muted, rgba(128,128,128,.9)); }
.da-box { border: 1px solid var(--border, rgba(128,128,128,.35)); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.da-box-error { border-color: rgba(217,48,37,.5); }
.da-muted { font-size: 12px; color: var(--muted, rgba(128,128,128,.9)); word-break: break-all; }
.da-pre { white-space: pre-wrap; font-size: 11px; max-height: 160px; overflow: auto; background: rgba(0,0,0,.07); padding: 8px; border-radius: 6px; }
.da-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.da-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; color: #fff; }
.da-new { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: #15803d; color: #fff; flex: none; }
.da-total { font-size: 13px; font-weight: 600; }
.da-note { font-size: 12px; color: #b45309; }
.da-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.da-chip { cursor: pointer; border: 1px solid var(--border, rgba(128,128,128,.4)); background: transparent; color: inherit; border-radius: 999px; padding: 2px 10px; font-size: 11px; }
.da-chip-on { background: var(--accent, #2563eb); color: #fff; border-color: transparent; }
.da-list { display: flex; flex-direction: column; gap: 6px; max-height: 440px; overflow: auto; }
.da-row { display: flex; align-items: flex-start; gap: 8px; }
.da-row-click { cursor: pointer; }
.da-sev { font-size: 10px; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; color: #fff; min-width: 52px; text-align: center; flex: none; }
.da-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.da-name { font-size: 13px; font-weight: 600; word-break: break-all; }
.da-open { font-size: 12px; color: var(--accent, #2563eb); cursor: pointer; word-break: break-all; text-decoration: underline; }
.da-critical { background: #d93025; }
.da-high { background: #d93025; }
.da-moderate { background: #b45309; }
.da-medium { background: #e8710a; }
.da-low { background: #1a73e8; }
.da-info { background: #0b7285; }
.da-unknown { background: #6b7280; }
.da-verdict { font-weight: 700; font-size: 13px; padding: 6px 10px; border-radius: 6px; }
`

function VerdictBanner({ verdict }: { verdict?: string }) {
  const map: Record<string, [string, string]> = {
    critical: ['🔴 发现高危问题', '#d93025'],
    warning: ['🟡 存在告警', '#e8710a'],
    clean: ['🟢 未发现风险', '#15803d'],
  }
  const m = map[verdict ?? 'clean'] ?? map.clean
  return createElement('div', { className: 'da-verdict', style: { color: m[1], border: `1px solid ${m[1]}` } }, m[0])
}

function SeverityBadges({ summary, supply }: { summary?: DepsecResult['summary']; supply: boolean }) {
  const s = summary ?? {}
  const keys: [string, string][] = supply
    ? [['high', '高危'], ['medium', '中危'], ['low', '低危'], ['info', '信息']]
    : [['critical', '严重'], ['high', '高危'], ['moderate', '中危'], ['low', '低危']]
  return createElement('div', { className: 'da-badges' },
    keys.map(([k, label]) => createElement('span', { key: k, className: `da-badge da-${k}` }, `${label} ${(s as Record<string, number>)[k] ?? 0}`)),
  )
}

function FilterBar({ value, newOnly, chips, onChange, onNewOnly }: {
  value: string; newOnly: boolean; chips: [string, string][]; onChange: (v: string) => void; onNewOnly: (v: boolean) => void
}) {
  const items = chips.map(([val, label]) =>
    createElement('button', { key: val, className: `da-chip${value === val ? ' da-chip-on' : ''}`, onClick: () => onChange(val) }, label),
  )
  items.push(createElement('button', { key: '__new', className: `da-chip${newOnly ? ' da-chip-on' : ''}`, onClick: () => onNewOnly(!newOnly) }, '只看新增'))
  return createElement('div', { className: 'da-filters' }, items)
}

function VulnView({ result, remote }: { result: DepsecResult; remote: DepsecRemote }) {
  const [sev, setSev] = useState('all')
  const [newOnly, setNewOnly] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [fixResult, setFixResult] = useState<{ ok: boolean; command?: string; error?: string } | null>(null)

  if (!result.ok) {
    return createElement('div', { className: 'da-box da-box-error' },
      createElement('div', { className: 'da-title' }, '审计未完成'),
      createElement('div', null, result.error ?? result.message ?? '未知错误'),
    )
  }
  const all = result.vulnerabilities ?? []
  let filtered = sev === 'all' ? all : all.filter((v) => (v.severity ?? 'unknown') === sev)
  if (newOnly) filtered = filtered.filter((v) => v.isNew)
  const rows = filtered.map((v, i) =>
    createElement('div', { key: i, className: 'da-row' },
      createElement('span', { className: `da-sev da-${v.severity ?? 'unknown'}` }, v.severity ?? '?'),
      createElement('div', { className: 'da-cell' },
        createElement('div', { className: 'da-name' }, v.isNew ? createElement('span', { className: 'da-new' }, '新') : null, ` ${v.name}${v.range ? ' ' + v.range : ''}`),
        v.title ? createElement('div', { className: 'da-muted' }, v.title) : null,
        v.fixAvailable ? createElement('div', { className: 'da-muted' }, '有可用修复') : null,
      ),
    ),
  )
  const s = result.summary
  const doFix = async () => {
    if (fixing) return
    setFixing(true)
    const carried = await remote.auditFix({})
    setFixResult(carried.ok ? carried.value : { ok: false, error: carried.error.message })
    setFixing(false)
  }
  const canFix = result.manager === 'npm' || result.manager === 'pnpm' || result.manager === 'yarn'
  return createElement('div', { className: 'da-box' },
    createElement('div', { className: 'da-title' }, `漏洞审计结果（${result.manager ?? ''}）`),
    createElement(VerdictBanner, { verdict: result.verdict }),
    createElement(SeverityBadges, { summary: result.summary, supply: false }),
    createElement('div', { className: 'da-total' }, `共 ${s?.total ?? 0} 个漏洞，新增 ${s?.newCount ?? 0}${sev !== 'all' || newOnly ? `（筛选后 ${filtered.length}）` : ''}`),
    createElement(FilterBar, { value: sev, newOnly, chips: [['all', '全部'], ['critical', '严重'], ['high', '高危'], ['moderate', '中危'], ['low', '低危']], onChange: setSev, onNewOnly: setNewOnly }),
    canFix ? createElement('button', { className: 'da-fix', onClick: doFix, disabled: fixing }, fixing ? '修复中…' : '一键修复（audit fix）') : null,
    fixResult ? createElement('div', { className: 'da-muted' }, fixResult.ok ? `修复完成：${fixResult.command}` : `修复失败：${fixResult.error ?? '未知'}`) : null,
    rows.length > 0 ? createElement('div', { className: 'da-list' }, rows) : createElement('div', { className: 'da-muted' }, '无匹配告警。'),
  )
}

function FindingsView({ result, label, remote, path }: { result: DepsecResult; label: string; remote: DepsecRemote; path: string }) {
  const [sev, setSev] = useState('all')
  const [newOnly, setNewOnly] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approvalsMsg, setApprovalsMsg] = useState<string | null>(null)
  if (!result.ok) {
    return createElement('div', { className: 'da-box da-box-error' },
      createElement('div', { className: 'da-title' }, `${label}未完成`),
      createElement('div', null, result.message ?? result.error ?? '未知错误'),
    )
  }

  const doApprovals = async () => {
    if (approving) return
    setApproving(true)
    const carried = await remote.writeApprovals({ path: path.trim() })
    setApprovalsMsg(carried.ok
      ? (carried.value.ok
        ? `放行清单已更新：新增 ${carried.value.added?.length ?? 0} 项，共 ${carried.value.total ?? 0} 项。${carried.value.note ?? ''}`
        : `写回失败：${carried.value.error ?? '未知'}`)
      : `写回失败：${carried.error.message}`)
    setApproving(false)
  }
  const all = result.findings ?? []
  let filtered = sev === 'all' ? all : all.filter((f) => f.severity === sev)
  if (newOnly) filtered = filtered.filter((f) => f.isNew)
  const rows = filtered.map((f, i) =>
    createElement('div', { key: i, className: `da-row${f.file ? ' da-row-click' : ''}`, onClick: f.file ? () => { void remote.openFile({ path: f.file!, line: f.line }) } : undefined },
      createElement('span', { className: `da-sev da-${f.severity ?? 'info'}` }, f.severity ?? '?'),
      createElement('div', { className: 'da-cell' },
        createElement('div', { className: 'da-name' }, f.isNew ? createElement('span', { className: 'da-new' }, '新') : null, ` ${f.kind ? f.kind + ' · ' : ''}${f.name ?? ''}${f.line ? ' :' + f.line : ''}`),
        f.detail ? createElement('div', { className: 'da-muted' }, f.detail) : null,
        f.file ? createElement('div', { className: 'da-open' }, '打开源文件') : null,
      ),
    ),
  )
  const s = result.summary
  const stats = result.stats ?? {}
  return createElement('div', { className: 'da-box' },
    createElement('div', { className: 'da-title' }, `${label}（${result.manager ?? '通用'}）`),
    createElement(VerdictBanner, { verdict: result.verdict }),
    createElement(SeverityBadges, { summary: result.summary, supply: true }),
    createElement('div', { className: 'da-total' }, `共 ${s?.total ?? 0} 个告警，新增 ${s?.newCount ?? 0}${sev !== 'all' || newOnly ? `（筛选后 ${filtered.length}）` : ''}`),
    createElement(FilterBar, { value: sev, newOnly, chips: [['all', '全部'], ['high', '高危'], ['medium', '中危'], ['low', '低危'], ['info', '信息']], onChange: setSev, onNewOnly: setNewOnly }),
    createElement('div', { className: 'da-muted' }, (stats.filesScanned ? `已扫描 ${stats.filesScanned} 个文件` : '') + (stats.historyCommits ? `，${stats.historyCommits} 个历史提交` : '') + (stats.nodeModulesScanned ? `，已扫描 node_modules ${stats.nodeModulesScanned} 个包` : '') + '。'),
    result.scope === 'supply-chain'
      ? createElement('div', { className: 'da-muted' },
          `install 脚本审查：${stats.scriptsPassed ?? 0} 通过 / ${stats.scriptsWarn ?? 0} 待查 / ${stats.scriptsBlocked ?? 0} 高危。`,
          createElement('button', { className: 'da-fix', onClick: doApprovals, disabled: approving, style: { marginLeft: 8 } }, approving ? '写回中…' : '写回放行清单（仅全 PASS 包）'),
        )
      : null,
    approvalsMsg ? createElement('div', { className: 'da-note' }, approvalsMsg) : null,
    rows.length > 0 ? createElement('div', { className: 'da-list' }, rows) : createElement('div', { className: 'da-muted' }, '无匹配告警。'),
  )
}

interface DepsecRemote {
  audit: (req: { path?: string; scope?: string }) => Promise<{ ok: boolean; value: DepsecResult; error: { message: string } } | { ok: false; value?: never; error: { message: string } }>
  auditFix: (req: { path?: string }) => Promise<{ ok: boolean; value: { ok: boolean; command?: string; error?: string }; error: { message: string } }>
  exportSarif: (req: { path?: string; scope?: string }) => Promise<{ ok: boolean; value: { ok: boolean; path?: string; resultCount?: number; error?: string }; error: { message: string } }>
  writeApprovals: (req: { path?: string }) => Promise<{ ok: boolean; value: { ok: boolean; added?: string[]; total?: number; error?: string; note?: string }; error: { message: string } }>
  monitorStatus: () => Promise<{ ok: boolean; value: { verdict?: string; total?: number } | null; error: { message: string } }>
  openFile: (req: { path: string; line?: number }) => Promise<{ ok: boolean; value: { ok: boolean; via?: string; error?: string }; error: { message: string } }>
}

function Panel({ remote }: { remote: DepsecRemote }) {
  const [result, setResult] = useState<DepsecResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [mode, setMode] = useState('vuln')
  const [mon, setMon] = useState<{ verdict?: string; total?: number } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [sarifMsg, setSarifMsg] = useState<string | null>(null)

  useEffect(() => {
    void remote.monitorStatus().then((c) => { if (c.ok) setMon(c.value) })
  }, [])

  const run = async () => {
    if (running) return
    setRunning(true)
    setError(null)
    const carried = await remote.audit({ path: path.trim(), scope: mode })
    if (carried.ok) setResult(carried.value)
    else setError(carried.error.message)
    setRunning(false)
  }

  const doExport = async () => {
    if (exporting) return
    setExporting(true)
    const carried = await remote.exportSarif({ path: path.trim(), scope: mode })
    setSarifMsg(carried.ok ? (carried.value.ok ? `已导出 SARIF：${carried.value.path}（${carried.value.resultCount} 条）` : `导出失败：${carried.value.error ?? '未知'}`) : `导出失败：${carried.error.message}`)
    setExporting(false)
  }

  const tab = (val: string, label: string) => createElement('button', { className: `da-tab${mode === val ? ' da-tab-on' : ''}`, onClick: () => setMode(val) }, label)
  const hints: Record<string, string> = {
    vuln: '官方审计（npm/pnpm/yarn/pip/cargo/go），查已知 CVE/GHSA。',
    'supply-chain': 'install 脚本内容审查（证据分级 PASS/WARN/BLOCK）+ typosquatting 近名 + registry 联网信誉；可一键写回放行清单。',
    secrets: '密钥/令牌泄露，含 git 历史 + 熵检测 + .depsecignore 白名单。',
    sast: '危险代码模式扫描（eval/命令注入/XSS/弱哈希等）。',
  }
  const monTxt = mon === null ? '自动监控：开启中…' : `自动监控：开启 · 上次投毒检测 ${mon.verdict === 'critical' ? '🔴高危' : mon.verdict === 'warning' ? '🟡有告警' : '🟢安全'}（${mon.total ?? 0}）`

  return createElement('div', { className: 'da-panel' },
    createElement('div', { className: 'da-head' },
      createElement('span', { className: 'da-title' }, '依赖安全审计'),
      createElement('div', { className: 'da-tabs' }, tab('vuln', '漏洞'), tab('supply-chain', '投毒'), tab('secrets', '密钥'), tab('sast', '代码')),
    ),
    createElement('div', { className: 'da-head' },
      createElement('input', { className: 'da-input', placeholder: '目录（留空=当前工作区）', value: path, onChange: (e: { target: { value: string } }) => setPath(e.target.value) }),
      createElement('button', { className: 'da-run', onClick: run, disabled: running }, running ? '审计中…' : '运行'),
      createElement('button', { className: 'da-export', onClick: doExport, disabled: exporting }, exporting ? '导出中…' : '导出 SARIF'),
    ),
    createElement('div', { className: 'da-hint' }, hints[mode] + ' 完成后弹 Windows 原生通知。'),
    createElement('div', { className: 'da-hint' }, monTxt),
    sarifMsg ? createElement('div', { className: 'da-muted' }, sarifMsg) : null,
    error !== null ? createElement('div', { className: 'da-box da-box-error' }, error) : null,
    result !== null
      ? (result.scope === 'vuln'
        ? createElement(VulnView, { result, remote })
        : createElement(FindingsView, { result, label: result.scope === 'supply-chain' ? '供应链/投毒扫描' : result.scope === 'secrets' ? '密钥扫描' : '代码扫描', remote, path }))
      : null,
  )
}

const remote: DepsecRemote = {
  audit: (req) => rpc('audit', { request: req }),
  auditFix: (req) => rpc('audit-fix', { request: req }),
  exportSarif: (req) => rpc('export-sarif', { request: req }),
  writeApprovals: (req) => rpc('write-approvals', { request: req }),
  monitorStatus: () => rpc('monitor-status', {}),
  openFile: (req) => rpc('open-file', { request: req }),
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dep-audit', order: 40, label: '依赖安全审计' },
    () => createElement(Panel, { remote }),
  ))
}
