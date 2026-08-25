/**
 * dsh-trust-list 浏览器半：设置页「依赖信任清单」。
 *
 * 拆分四个区域（替代 0.2 的"挤在一起"布局）：
 *   1. 头部：标题 + 模式 tabs + 自动监控状态
 *   2. 操作区：目录输入 + [运行] [修复] [导出 SARIF] + [写回放行清单](主按钮)
 *   3. 当前模式说明 + 提醒
 *   4. 结果区（按 scope 不同渲染）
 *
 * 每条告警下面挂"建议动作"按钮：打开源文件 / 加白名单 / 忽略 ——
 * 让用户一眼看出"下一步该点什么"，而不是面对一堆 da-badge da-high 无所适从。
 *
 * @module dsh-trust-list/client
 */

import { createElement, useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AuditRequest,
  BlockVerdict,
  DepsecResult,
  OpenFileRequest,
  WriteApprovalsRequest,
} from './types.ts'

// CSS 不在这里 import：.build-tools/build.cjs 在 client bundle factory 顶部
// 手工 inline 一个 <style> 注入节点（避免 build.cjs 处理 .css import）。
// 类名走全局 .da-*：UI 一次性注入 settings 面板，不需要 CSS Modules 作用域。

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
        // dsh TypertGateway 协议：
        //   payload.args 的 keys 必须 = descriptor.parameters[*].wire
        // 当前 host 用 TypertRemoteService，第一个参数叫 `request`，wire='request'，
        // 所以 args 里直接放 `{ request: { ... } }`。每个 method 自己的包装层
        // 负责把业务 request 对象塞到 `request` 字段里（见下面 const remote）。
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

/**
 * 判定横幅：把 3 档 (pass/warn/block) 渲染成颜色 + 文字。
 * 旧 verdict 字段（clean/warning/critical）继续生效但已被 blockVerdict 替代。
 */
function VerdictBanner({ verdict, blockVerdict }: { verdict?: string; blockVerdict?: BlockVerdict }) {
  // 优先消费 blockVerdict；缺失时回退到 verdict 字段（兼容 0.2.x 数据）
  const v: BlockVerdict = blockVerdict
    ?? (verdict === 'critical' ? 'block' : verdict === 'warning' ? 'warn' : 'pass')
  const map: Record<BlockVerdict, { label: string; cls: string }> = {
    pass: { label: 'PASS · 未发现风险', cls: 'da-verdictPass' },
    warn: { label: 'WARN · 存在告警（建议人工看）', cls: 'da-verdictWarn' },
    block: { label: 'BLOCK · 高危信号（不要放行）', cls: 'da-verdictBlock' },
  }
  const m = map[v]
  return createElement('div', { className: `da-verdict ${m.cls}` }, m.label)
}

function SeverityBadges({ summary, supply }: { summary?: DepsecResult['summary']; supply: boolean }) {
  const s = summary ?? {}
  const keys: [string, string][] = supply
    ? [['high', '高危'], ['medium', '中危'], ['low', '低危'], ['info', '信息']]
    : [['critical', '严重'], ['high', '高危'], ['moderate', '中危'], ['low', '低危']]
  return createElement('div', { className: 'da-badges' },
    keys.map(([k, label]) => createElement('span', { key: k, className: `da-badge da-badge${k.charAt(0).toUpperCase()}${k.slice(1)}` }, `${label} ${(s as Record<string, number>)[k] ?? 0}`)),
  )
}

function FilterBar({ value, newOnly, chips, onChange, onNewOnly }: {
  value: string; newOnly: boolean; chips: [string, string][]; onChange: (v: string) => void; onNewOnly: (v: boolean) => void
}) {
  const items = chips.map(([val, label]) =>
    createElement('button', { key: val, className: `da-chip${value === val ? ' da-chipOn' : ''}`, onClick: () => onChange(val) }, label),
  )
  items.push(createElement('button', { key: '__new', className: `da-chip${newOnly ? ' da-chipOn' : ''}`, onClick: () => onNewOnly(!newOnly) }, '只看新增'))
  return createElement('div', { className: 'da-filters' }, items)
}

/**
 * 每条告警底部的"建议动作"。三个动作：
 *  1. 打开源文件（有 file 字段时显示，调 openFile RPC）
 *  2. 忽略此路径（仅 UI 层标记，不持久化；同会话内筛掉）
 *  3. 忽略此类（按 name 标记）
 */
function FindingActions({ f, onIgnore, onIgnorePath }: {
  f: { file?: string; name: string; line?: number }
  onIgnore: (name: string) => void
  onIgnorePath: (path: string) => void
}) {
  const items: ReturnType<typeof createElement>[] = []
  if (f.file) {
    const req: OpenFileRequest = { path: f.file, line: f.line }
    items.push(createElement('button', {
      key: 'open', className: 'da-actionBtn',
      onClick: () => { void remote.openFile(req) },
    }, '打开源文件'))
    items.push(createElement('button', {
      key: 'ignorePath', className: 'da-actionBtn',
      onClick: () => onIgnorePath(f.file as string),
    }, '忽略此路径'))
  }
  items.push(createElement('button', {
    key: 'ignoreName', className: 'da-actionBtn',
    onClick: () => onIgnore(f.name),
  }, '忽略此类'))
  return createElement('div', { className: 'da-actions' }, items)
}

function VulnView({ result, remote, ignoreSet, onIgnore }: { result: DepsecResult; remote: DepsecRemote; ignoreSet: Set<string>; onIgnore: (name: string) => void }) {
  const [sev, setSev] = useState('all')
  const [newOnly, setNewOnly] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [fixResult, setFixResult] = useState<{ ok: boolean; command?: string; error?: string } | null>(null)

  if (!result.ok) {
    return createElement('div', { className: 'da-box da-boxError' },
      createElement('div', { className: 'da-boxTitle' }, '漏洞审计未完成'),
      createElement('div', null, result.error ?? result.message ?? '未知错误'),
    )
  }
  const all = (result.vulnerabilities ?? []).filter((v) => !ignoreSet.has(v.name))
  let filtered = sev === 'all' ? all : all.filter((v) => (v.severity ?? 'unknown') === sev)
  if (newOnly) filtered = filtered.filter((v) => v.isNew)
  const rows = filtered.map((v, i) => {
    const sevCls = v.severity === 'critical' ? 'Critical' : v.severity === 'high' ? 'High' : v.severity === 'moderate' || v.severity === 'medium' ? 'Moderate' : v.severity === 'low' ? 'Low' : v.severity === 'info' ? 'Info' : 'Unknown'
    return createElement('div', { key: i, className: 'da-row' },
      createElement('span', { className: `da-sev da-sev${sevCls}` }, v.severity ?? '?'),
      createElement('div', { className: 'da-cell' },
        createElement('div', { className: 'da-name' },
          v.isNew ? createElement('span', { className: 'da-isNew' }, '新') : null,
          ` ${v.name}${v.range ? ' ' + v.range : ''}`),
        v.title ? createElement('div', { className: 'da-detail' }, v.title) : null,
        v.fixAvailable ? createElement('div', { className: 'da-detail' }, '有可用修复（点"一键修复"按钮）') : null,
      ),
    )
  })
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
    createElement('div', { className: 'da-boxTitle' }, `漏洞审计结果（${result.manager ?? ''}）`),
    createElement(VerdictBanner, { verdict: result.verdict, blockVerdict: result.blockVerdict }),
    createElement(SeverityBadges, { summary: result.summary, supply: false }),
    createElement('div', { className: 'da-total' }, `共 ${s?.total ?? 0} 个漏洞，新增 ${s?.newCount ?? 0}${sev !== 'all' || newOnly ? `（筛选后 ${filtered.length}）` : ''}`),
    createElement(FilterBar, { value: sev, newOnly, chips: [['all', '全部'], ['critical', '严重'], ['high', '高危'], ['moderate', '中危'], ['low', '低危']], onChange: setSev, onNewOnly: setNewOnly }),
    canFix ? createElement('button', { className: 'da-btnSecondary', onClick: doFix, disabled: fixing }, fixing ? '修复中…' : '一键修复（audit fix）') : null,
    fixResult ? createElement('div', { className: 'da-muted' }, fixResult.ok ? `修复完成：${fixResult.command}` : `修复失败：${fixResult.error ?? '未知'}`) : null,
    rows.length > 0 ? createElement('div', { className: 'da-list' }, rows) : createElement('div', { className: 'da-muted' }, '无匹配告警。'),
  )
}

function FindingsView({ result, label, remote, path, ignoreSet, onIgnore, onIgnorePath }: {
  result: DepsecResult
  label: string
  remote: DepsecRemote
  path: string
  ignoreSet: Set<string>
  onIgnore: (name: string) => void
  onIgnorePath: (p: string) => void
}) {
  const [sev, setSev] = useState('all')
  const [newOnly, setNewOnly] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approvalsMsg, setApprovalsMsg] = useState<string | null>(null)
  if (!result.ok) {
    return createElement('div', { className: 'da-box da-boxError' },
      createElement('div', { className: 'da-boxTitle' }, `${label}未完成`),
      createElement('div', null, result.message ?? result.error ?? '未知错误'),
    )
  }

  const doApprovals = async () => {
    if (approving) return
    setApproving(true)
    const req: WriteApprovalsRequest = { path: path.trim() }
    const carried = await remote.writeApprovals(req)
    setApprovalsMsg(carried.ok
      ? (carried.value.ok
        ? `放行清单已更新：新增 ${carried.value.added?.length ?? 0} 项，共 ${carried.value.total ?? 0} 项。${carried.value.note ?? ''}`
        : `写回失败：${carried.value.error ?? '未知'}`)
      : `写回失败：${carried.error.message}`)
    setApproving(false)
  }
  const all = (result.findings ?? []).filter((f) => !(ignoreSet.has(f.name) || (f.file !== undefined && ignoreSet.has(f.file))))
  let filtered = sev === 'all' ? all : all.filter((f) => f.severity === sev)
  if (newOnly) filtered = filtered.filter((f) => f.isNew)
  const rows = filtered.map((f, i) => {
    const sevCls = f.severity === 'high'
      ? 'High'
      : f.severity === 'medium'
      ? 'Medium'
      : f.severity === 'low'
      ? 'Low'
      : f.severity === 'info'
      ? 'Info'
      : 'Unknown'
    return createElement('div', {
      key: i,
      className: `da-row${f.file ? ' da-rowClick' : ''}`,
      onClick: f.file ? () => { void remote.openFile({ path: f.file!, line: f.line }) } : undefined,
    },
      createElement('span', { className: `da-sev da-sev${sevCls}` }, f.severity ?? '?'),
      createElement('div', { className: 'da-cell' },
        createElement('div', { className: 'da-name' },
          f.isNew ? createElement('span', { className: 'da-isNew' }, '新') : null,
          ` ${f.kind ? f.kind + ' · ' : ''}${f.name ?? ''}${f.line ? ' :' + f.line : ''}`),
        f.detail ? createElement('div', { className: 'da-detail' }, f.detail) : null,
        createElement(FindingActions, { f, onIgnore, onIgnorePath }),
      ),
    )
  })
  const s = result.summary
  const stats = result.stats ?? {}
  const hasApprovals = result.scope === 'supply-chain' && (stats.scriptsPassed ?? 0) > 0
  // 主按钮 vs 危险按钮：blockVerdict=block 时禁止一键放行；其他情况主按钮
  const block = result.blockVerdict === 'block'
  return createElement('div', { className: 'da-box' },
    createElement('div', { className: 'da-boxTitle' }, `${label}（${result.manager ?? '通用'}）`),
    createElement(VerdictBanner, { verdict: result.verdict, blockVerdict: result.blockVerdict }),
    createElement(SeverityBadges, { summary: result.summary, supply: true }),
    createElement('div', { className: 'da-total' }, `共 ${s?.total ?? 0} 个告警，新增 ${s?.newCount ?? 0}${sev !== 'all' || newOnly ? `（筛选后 ${filtered.length}）` : ''}`),
    createElement(FilterBar, { value: sev, newOnly, chips: [['all', '全部'], ['high', '高危'], ['medium', '中危'], ['low', '低危'], ['info', '信息']], onChange: setSev, onNewOnly: setNewOnly }),
    createElement('div', { className: 'da-muted' },
      (stats.filesScanned ? `已扫描 ${stats.filesScanned} 个文件` : '') +
      (stats.historyCommits ? `，${stats.historyCommits} 个历史提交` : '') +
      (stats.nodeModulesScanned ? `，已扫描 node_modules ${stats.nodeModulesScanned} 个包` : '') + '。'),
    result.scope === 'supply-chain'
      ? createElement('div', { className: 'da-muted' },
          `install 脚本审查：${stats.scriptsPassed ?? 0} 通过 / ${stats.scriptsWarn ?? 0} 待查 / ${stats.scriptsBlocked ?? 0} 高危。`,
          hasApprovals
            ? createElement('button', {
                className: block ? 'da-btnDanger' : 'da-btnPrimary',
                onClick: doApprovals,
                disabled: approving,
                style: { marginLeft: 8 },
              }, block
                  ? '⚠ BLOCK 状态下不可写回放行清单'
                  : (approving ? '写回中…' : '一键写回放行清单（仅 PASS 包）'))
            : null,
        )
      : null,
    approvalsMsg ? createElement('div', { className: 'da-note' }, approvalsMsg) : null,
    rows.length > 0 ? createElement('div', { className: 'da-list' }, rows) : createElement('div', { className: 'da-muted' }, '无匹配告警。'),
  )
}

interface DepsecRemote {
  audit: (req: AuditRequest) => Promise<{ ok: boolean; value: DepsecResult; error: { message: string } } | { ok: false; value?: never; error: { message: string } }>
  auditFix: (req: { path?: string }) => Promise<{ ok: boolean; value: { ok: boolean; command?: string; error?: string }; error: { message: string } }>
  exportSarif: (req: { path?: string; scope?: string }) => Promise<{ ok: boolean; value: { ok: boolean; path?: string; resultCount?: number; error?: string }; error: { message: string } }>
  writeApprovals: (req: WriteApprovalsRequest) => Promise<{ ok: boolean; value: { ok: boolean; added?: string[]; total?: number; error?: string; note?: string }; error: { message: string } }>
  monitorStatus: () => Promise<{ ok: boolean; value: { verdict?: string; total?: number } | null; error: { message: string } }>
  openFile: (req: OpenFileRequest) => Promise<{ ok: boolean; value: { ok: boolean; via?: string; error?: string }; error: { message: string } }>
  // scanInstalledPlugins 暂未在 UI 暴露（dsh sandbox 限制），但 host 端 RPC 仍在
  // —— DepsecService 上 @Remote('scan-installed-plugins') 已注册，类型为
  // { profile?: string } → PluginRosterResult。等沙箱放开后 un-comment 客户端即可。
  // scanInstalledPlugins: (req: { profile?: string }) => Promise<{ ok: boolean; value: PluginRosterResult; error: { message: string } }>
}

/**
 * 已安装插件审查视图 —— 暂未启用：
 * dsh sandbox workspace-write 模式下插件无法访问 ~/.dsh/profiles/*（不在 workspace
 * 根下，被 windows-acl-run 拒绝），所以这个功能现在点下去必然失败。等 dsh 沙箱放开
 * profile 访问，把这个组件 un-comment 即可恢复（host 端 @Remote('scan-installed-plugins')
 * RPC + listProfileBundles() 都在，零行 host 代码改动）。
 *
 * function PluginRosterView({ result, onScan, scanning }: {
 *   result: PluginRosterResult | null
 *   onScan: () => void
 *   scanning: boolean
 * }) {
 *   // 完整实现略——见 git history 0.3.0 之前的 client.ts
 * }
 */

function Panel({ remote }: { remote: DepsecRemote }) {
  const [result, setResult] = useState<DepsecResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<'vuln' | 'supply-chain' | 'secrets' | 'sast'>('vuln')
  const [mon, setMon] = useState<{ verdict?: string; total?: number } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [sarifMsg, setSarifMsg] = useState<string | null>(null)
  // 本会话内的忽略集合（不持久化；与 .depsecignore 并存）
  const [ignoreSet, setIgnoreSet] = useState<Set<string>>(new Set())

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

  const onIgnore = (name: string) => {
    setIgnoreSet((prev) => {
      const next = new Set(prev)
      next.add(name)
      return next
    })
  }
  const onIgnorePath = (p: string) => {
    setIgnoreSet((prev) => {
      const next = new Set(prev)
      next.add(p)
      return next
    })
  }

  const tab = (val: string, label: string) => createElement('button', { className: `da-tab${mode === val ? ' da-tabOn' : ''}`, onClick: () => setMode(val) }, label)
  const hints: Record<string, string> = {
    vuln: '官方漏洞审计（npm/pnpm/yarn/pip/cargo/go），查已知 CVE/GHSA。',
    'supply-chain': 'install 脚本内容审查（PASS/WARN/BLOCK 证据分级）+ typosquatting 近名 + registry 联网信誉；可一键写回放行清单。',
    secrets: '密钥/令牌泄露，含 git 历史 + 熵检测 + .depsecignore 白名单。',
    sast: '危险代码模式扫描（eval/命令注入/XSS/弱哈希等）。',
  }
  const monTxt = mon === null ? '自动监控：开启中…' : `自动监控：开启 · 上次投毒检测 ${mon.verdict === 'critical' ? '🔴高危' : mon.verdict === 'warning' ? '🟡有告警' : '🟢安全'}（${mon.total ?? 0}）`

  // 头部：标题 + tabs + 监控状态
  const header = createElement('div', { className: 'da-header' },
    createElement('span', { className: 'da-title' }, '依赖信任清单'),
    createElement('div', { className: 'da-tabs' },
      tab('vuln', '漏洞'),
      tab('supply-chain', '信任清单'),
      tab('secrets', '密钥'),
      tab('sast', '代码'),
    ),
  )

  // 主按钮（写回放行清单 仅在 supply-chain 模式显示）
  const writeBtn = mode === 'supply-chain'
    ? createElement('button', {
        className: result?.blockVerdict === 'block' ? 'da-btnDanger' : 'da-btnPrimary',
        disabled: !result || result.blockVerdict === 'block',
        title: result?.blockVerdict === 'block' ? '当前 BLOCK 状态下不可一键写回放行清单' : '仅写入脚本全 PASS 且无中高危信号的依赖',
      }, result?.blockVerdict === 'block' ? '⚠ BLOCK 不可写回' : '一键写回放行清单')
    : null

  const actionBar = createElement('div', { className: 'da-actionBar' },
    createElement('input', {
      className: 'da-input',
      placeholder: '目录（留空=当前工作区）',
      value: path,
      onChange: (e: { target: { value: string } }) => setPath(e.target.value),
    }),
    createElement('button', { className: 'da-btnSecondary', onClick: run, disabled: running }, running ? '审计中…' : '运行'),
    writeBtn,
    createElement('button', { className: 'da-btnSecondary', onClick: doExport, disabled: exporting }, exporting ? '导出中…' : '导出 SARIF'),
  )

  // 模式说明 + 监控状态
  const explainer = createElement('div', { className: 'da-hint' },
    hints[mode],
    ' 完成后弹 Windows 原生通知；自动监控在装新依赖时触发。',
  )

  return createElement('div', { className: 'da-panel' },
    header,
    createElement('div', { className: 'da-monitor' }, monTxt),
    actionBar,
    explainer,
    sarifMsg ? createElement('div', { className: 'da-muted' }, sarifMsg) : null,
    error !== null ? createElement('div', { className: 'da-box da-boxError' }, error) : null,
    result !== null
      ? (result.scope === 'vuln'
        ? createElement(VulnView, { result, remote, ignoreSet, onIgnore })
        : createElement(FindingsView, { result, label: result.scope === 'supply-chain' ? '供应链/投毒扫描' : result.scope === 'secrets' ? '密钥扫描' : '代码扫描', remote, path, ignoreSet, onIgnore, onIgnorePath }))
      : null,
  )
}

const remote: DepsecRemote = {
  audit: (req) => rpc('audit', { request: req ?? {} }),
  auditFix: (req) => rpc('audit-fix', { request: req ?? {} }),
  exportSarif: (req) => rpc('export-sarif', { request: req ?? {} }),
  writeApprovals: (req) => rpc('write-approvals', { request: req ?? {} }),
  monitorStatus: () => rpc('monitor-status', {}),
  openFile: (req) => rpc('open-file', { request: req }),
  // scanInstalledPlugins 暂未在 UI 暴露（dsh sandbox 限制）—— host 端 RPC 仍注册。
  // scanInstalledPlugins: (req) => rpc('scan-installed-plugins', { request: req ?? {} }),
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'trust-list', order: 40, label: '依赖信任清单' },
    () => createElement(Panel, { remote }),
  ))
}