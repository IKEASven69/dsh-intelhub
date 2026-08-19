/**
 * dsh-depsec host 半：TypertRemoteService，提供 Client→Host RPC
 * （audit / audit-fix / export-sarif / monitor-status / open-file），
 * 并在 init 里注册 dep_audit 模型工具、监听依赖安装自动值守。
 * @module dsh-depsec
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ShellExecRequest } from '@deepseek-ai/dsh-shell'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox-policy'
import type {
  AuditRequest,
  DepsecFinding,
  DepsecResult,
  DepsecScope,
  DepsecSummary,
  DepsecVulnerability,
  FixRequest,
  FixResult,
  MonitorState,
  OpenFileRequest,
  SarifResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    depsec: DepsecService
  }
}

const COMMANDS: Record<string, string | null> = {
  npm: 'npm audit --json',
  pnpm: 'pnpm audit --json',
  yarn: 'yarn audit --json',
  bun: null,
  pip: 'pip-audit --format json',
  cargo: 'cargo audit --json',
  go: 'govulncheck -json ./...',
}

const FIX_COMMANDS: Record<string, string> = {
  npm: 'npm audit fix',
  pnpm: 'pnpm audit fix',
  yarn: 'yarn audit fix',
}

const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall']

const INSTALL_RE =
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|update|up)\b|\bpip\s+install\b|\bcargo\s+(add|install)\b|\bgo\s+get\b|\bcomposer\s+require\b|\bgem\s+install\b/i

const TOP_PACKAGES = [
  'express', 'koa', 'react', 'react-dom', 'vue', 'angular', 'lodash', 'underscore', 'axios',
  'moment', 'dayjs', 'date-fns', 'chalk', 'commander', 'debug', 'typescript', 'webpack',
  'vite', 'rollup', 'esbuild', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'chai',
  'next', 'nuxt', 'redux', 'mobx', 'rxjs', 'graphql', 'socket.io', 'ws', 'mongoose',
  'sequelize', 'typeorm', 'prisma', 'knex', 'pg', 'mysql', 'mysql2', 'sqlite3', 'redis',
  'ioredis', 'aws-sdk', 'got', 'node-fetch', 'dotenv', 'cross-env', 'rimraf', 'fs-extra',
  'glob', 'minimist', 'yargs', 'inquirer', 'ora', 'nodemon', 'concurrently', 'husky',
  'semver', 'uuid', 'nanoid', 'classnames', 'prop-types', 'styled-components', 'tailwindcss',
  'sass', 'postcss', 'autoprefixer', 'electron', 'puppeteer', 'playwright', 'cheerio',
  'jsdom', 'jsonwebtoken', 'bcrypt', 'helmet', 'cors', 'morgan', 'winston', 'pino',
  'web3', 'ethers', 'zod', 'yup', 'joi',
]

interface Pattern {
  name: string
  regex: RegExp
  severity: string
}

const SECRET_PATTERNS: Pattern[] = [
  { name: 'AWS Access Key', regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, severity: 'high' },
  { name: 'GitHub Token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, severity: 'high' },
  { name: 'GitLab Token', regex: /\bglpat-[A-Za-z0-9-]{20,}\b/, severity: 'high' },
  { name: 'OpenAI API Key', regex: /\bsk-[A-Za-z0-9]{20,}\b/, severity: 'high' },
  { name: 'Slack Token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, severity: 'high' },
  { name: 'Stripe Live Key', regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}\b/, severity: 'high' },
  { name: 'Google API Key', regex: /\bAIza[0-9A-Za-z-_]{35}\b/, severity: 'high' },
  { name: 'NPM Token', regex: /\bnpm_[A-Za-z0-9]{36}\b/, severity: 'high' },
  { name: '私钥 PEM', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, severity: 'high' },
  { name: 'Basic Auth URL', regex: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@[^/\s]+/, severity: 'high' },
  { name: 'JWT Token', regex: /\beyJ[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}\b/, severity: 'medium' },
  { name: '密钥赋值', regex: /(api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][A-Za-z0-9/+_-]{8,}["']/i, severity: 'low' },
]

const SAST_PATTERNS: Pattern[] = [
  { name: 'eval 动态执行', regex: /\beval\s*\(/, severity: 'medium' },
  { name: 'new Function', regex: /\bnew\s+Function\s*\(/, severity: 'medium' },
  { name: '命令执行 exec', regex: /\b(?:exec|execSync)\s*\(/, severity: 'medium' },
  { name: 'XSS innerHTML', regex: /\.innerHTML\s*[=+]/, severity: 'low' },
  { name: 'shell=True 命令注入', regex: /\bshell\s*=\s*True/, severity: 'high' },
  { name: 'os.system', regex: /\bos\.system\s*\(/, severity: 'medium' },
  { name: 'pickle 反序列化', regex: /\bpickle\.(?:loads|load)\s*\(/, severity: 'high' },
  { name: '弱哈希 MD5/SHA1', regex: /\b(?:MD5|SHA1|md5|sha1)\s*\(/, severity: 'low' },
  { name: '硬编码密码', regex: /(password|passwd|pwd)\s*[:=]\s*["'][^"']{6,}["']/i, severity: 'high' },
]

const SKIP_DIRS = [
  'node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', 'coverage', 'target',
  '__pycache__', '.cache', '.idea', '.vscode', 'vendor', '.dsh', 'out', 'bin', 'obj',
  '.turbo', '.nuxt', '.svelte-kit', '.terraform',
]

const CANDIDATE_EXTS = [
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.rb',
  '.php', '.cs', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.sh', '.ps1', '.env',
  '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.xml',
  '.sql', '.gradle', '.kts', '.pem', '.key', '.crt', '.tf', '.tfvars',
]

function normSeverity(s: unknown): string {
  const sev = String(s === undefined || s === null ? 'unknown' : s).toLowerCase()
  if (sev === 'medium' || sev === 'moderate') return 'moderate'
  if (sev === 'critical' || sev === 'high' || sev === 'low' || sev === 'info') return sev
  return 'unknown'
}

function verdictOf(summary?: DepsecSummary): DepsecResult['verdict'] {
  if (!summary) return 'clean'
  if ((summary.critical ?? 0) > 0 || (summary.high ?? 0) > 0) return 'critical'
  if ((summary.total ?? 0) > 0) return 'warning'
  return 'clean'
}

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0
  const freq: Record<string, number> = {}
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1
  let h = 0
  for (const c in freq) {
    const p = freq[c] / s.length
    h -= p * Math.log2(p)
  }
  return h
}

function looksRandom(s: string): boolean {
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)
}

/**
 * 依赖安全审计服务。所有 Client→Host 调用走这里，dep_audit 模型工具也在此注册。
 */
export class DepsecService extends TypertRemoteService {
  static inject = ['shell', 'fs', 'sandboxPolicy', 'agents', 'web', 'tools']

  private readonly baseline = new Map<string, Set<string>>()
  private monitoringState: MonitorState | null = null
  private lastAutoAt = 0

  constructor(ctx: Context) {
    super(ctx, 'depsec')
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.tools.register(defineTool({
      name: 'dep_audit',
      description: '审计当前工作区项目安全，scope 可选：vuln（官方漏洞审计）、supply-chain（投毒检测）、secrets（密钥泄露，含 git 历史与熵检测）、sast（危险代码）。可选 path 指定目录。支持 .depsecignore 白名单与基线新增标记。审计完成后弹 Windows 原生通知。',
      parameters: {
        path: { type: 'string', description: '可选：要审计的目录绝对路径，默认当前工作区根目录' },
        scope: { type: 'string', enum: ['vuln', 'supply-chain', 'secrets', 'sast'], description: '审计范围：vuln=已知漏洞(默认)，supply-chain=供应链/投毒，secrets=密钥泄露，sast=代码风险' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: DepsecResult) => [{ type: 'text', text: this.renderText(value) }],
      },
      execute: async (args: AuditRequest) => {
        return await this.runAudit(args?.path, args?.scope ?? 'vuln')
      },
    }))

    this.ctx.on('tools/result', (exec: { name?: string; arguments?: unknown; agent?: Agent }) => {
      try {
        if (exec === null || typeof exec !== 'object') return
        if (exec.name !== 'bash' && exec.name !== 'pwsh') return
        const args = exec.arguments as { command?: unknown } | null
        if (args === null || typeof args !== 'object') return
        const cmd = args.command
        if (typeof cmd !== 'string') return
        if (!INSTALL_RE.test(cmd)) return
        void this.autoScanAfterInstall(exec.agent)
      } catch {
        /* best-effort */
      }
    })
  }

  @Remote('audit')
  async audit(request: AuditRequest = {}): Promise<DepsecResult> {
    return await this.runAudit(request.path, request.scope ?? 'vuln')
  }

  @Remote('audit-fix')
  async auditFix(request: FixRequest = {}): Promise<FixResult> {
    const root = this.rootFor(request.path)
    if (root === undefined) return { ok: false, error: '无法确定工作区根目录' }
    const det = await this.detectManager(root)
    const fix = FIX_COMMANDS[det.manager]
    if (fix === undefined) return { ok: false, error: '当前包管理器不支持自动修复' }
    const run = await this.runCommand(fix, root)
    if (run.exitCode !== 0) return { ok: false, error: `自动修复失败（退出码 ${run.exitCode}）`, stdoutTail: run.stderr.slice(0, 2000) }
    return { ok: true, command: fix, stdoutTail: run.stdout.slice(0, 2000) }
  }

  @Remote('export-sarif')
  async exportSarif(request: AuditRequest = {}): Promise<SarifResult> {
    const root = this.rootFor(request.path)
    if (root === undefined) return { ok: false, error: '无法确定工作区根目录' }
    const result = await this.runScope(root, request.scope ?? 'vuln')
    if (!result.ok) return { ok: false, error: result.message ?? result.error ?? '扫描失败' }
    const sarif = this.buildSarif(result)
    const outPath = this.joinPath(root, 'depsec.sarif.json')
    try {
      await this.ctx.fs.writeText(await this.ctx.fs.resolve(outPath), JSON.stringify(sarif, null, 2))
    } catch (e) {
      return { ok: false, error: `写入 SARIF 失败：${e instanceof Error ? e.message : String(e)}` }
    }
    const run = sarif.runs[0]
    return { ok: true, path: outPath, ruleCount: run?.tool.driver.rules.length, resultCount: run?.results.length }
  }

  @Remote('monitor-status')
  async monitorStatus(): Promise<MonitorState | null> {
    return this.monitoringState
  }

  @Remote('open-file')
  async openFile(request: OpenFileRequest): Promise<{ ok: boolean; via?: string; error?: string }> {
    const path = request?.path
    if (typeof path !== 'string' || path.length === 0) return { ok: false, error: '无文件路径' }
    const safe = path.replace(/['"`\r\n]/g, ' ')
    const line = request.line ?? 1
    try {
      const r1 = await this.runCommand(`code --goto "${safe}:${line}"`)
      if (r1.exitCode === 0) return { ok: true, via: 'vscode' }
    } catch {
      /* fall through */
    }
    try {
      await this.runCommand(`explorer.exe /select,"${safe}"`)
      return { ok: true, via: 'explorer' }
    } catch {
      return { ok: false, error: `无法打开文件：${path}` }
    }
  }

  // ── 业务逻辑 ──────────────────────────────────────────────

  private currentRoot(): string | undefined {
    const sp = this.ctx.sandboxPolicy
    const agent = this.ctx.agents.currentInitiator()
    if (agent?.session !== undefined) return sp.resolve({ session: agent.session }).workspaceRoot
    return sp.workspaceRoot
  }

  private rootFor(path: string | undefined): string | undefined {
    if (typeof path === 'string' && path.length > 0) return path
    return this.currentRoot()
  }

  private rootOfAgent(agent: Agent | undefined): string | undefined {
    if (agent?.session !== undefined) return this.ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot
    return this.currentRoot()
  }

  private joinPath(root: string, name: string): string {
    return root.replace(/[\\/]+$/, '') + '/' + name
  }

  private async runCommand(command: string, workdir?: string) {
    const spec = this.ctx.shell.resolve({ command, ...(workdir === undefined ? {} : { workdir }), timeoutMs: 120000, stdoutMaxBytes: 1048576 } as ShellExecRequest)
    const result = await this.ctx.shell.run(spec)
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
      stdout: result.stdout?.text ?? '',
      stderr: result.stderr?.text ?? '',
    }
  }

  private async readTextFile(path: string): Promise<string | null> {
    try {
      const t = await this.ctx.fs.resolve(path)
      const info = await this.ctx.fs.stat(t)
      if (info === undefined || info.type !== 'file') return null
      return await this.ctx.fs.readText(t)
    } catch {
      return null
    }
  }

  private async readJson(path: string): Promise<Record<string, unknown> | null> {
    const text = await this.readTextFile(path)
    if (text === null) return null
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private async detectManager(root: string): Promise<{ manager: string; reason?: string }> {
    const entries = await this.ctx.fs.listDir(await this.ctx.fs.resolve(root))
    const names = entries.map((e) => e.name)
    const has = (n: string) => names.includes(n)
    if (has('package.json')) {
      if (has('pnpm-lock.yaml')) return { manager: 'pnpm' }
      if (has('yarn.lock')) return { manager: 'yarn' }
      if (has('bun.lockb') || has('bun.lock')) return { manager: 'bun' }
      return { manager: 'npm' }
    }
    if (has('Cargo.toml')) return { manager: 'cargo' }
    if (has('requirements.txt') || has('pyproject.toml') || has('poetry.lock') || has('Pipfile')) return { manager: 'pip' }
    if (has('go.mod')) return { manager: 'go' }
    return { manager: 'unknown' }
  }

  private scriptsOf(pkg: Record<string, unknown> | null): { script: string; command: string }[] {
    if (pkg === null || typeof pkg !== 'object') return []
    const scripts = pkg.scripts
    if (scripts === null || typeof scripts !== 'object') return []
    const out: { script: string; command: string }[] = []
    for (const k of INSTALL_SCRIPT_KEYS) {
      const v = (scripts as Record<string, unknown>)[k]
      if (typeof v === 'string' && v.trim().length > 0) out.push({ script: k, command: v.trim() })
    }
    return out
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length
    const n = b.length
    if (m === 0) return n
    if (n === 0) return m
    const dp: number[][] = []
    for (let i = 0; i <= m; i++) dp.push([i])
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
      }
    }
    return dp[m][n]
  }

  private typosquatting(names: string[]): DepsecFinding[] {
    const out: DepsecFinding[] = []
    for (const name of names) {
      let best: string | null = null
      let bestDist = 3
      for (const top of TOP_PACKAGES) {
        if (top === name) { best = null; bestDist = 0; break }
        const d = this.levenshtein(name, top)
        if (d < bestDist) { bestDist = d; best = top }
      }
      if (best !== null && bestDist === 1) out.push({ kind: '疑似近名投毒', name, detail: `与流行包 \`${best}\` 仅差 ${bestDist} 字符`, severity: 'high' })
      else if (best !== null && bestDist === 2 && name.length >= 5) out.push({ kind: '疑似近名投毒', name, detail: `与流行包 \`${best}\` 仅差 ${bestDist} 字符`, severity: 'medium' })
    }
    return out
  }

  private async scanNodeModules(root: string): Promise<{ findings: { name: string; scripts: { script: string; command: string }[] }[]; scanned: number; skipped: string }> {
    const nmPath = this.joinPath(root, 'node_modules')
    let entries
    try {
      entries = await this.ctx.fs.listDir(await this.ctx.fs.resolve(nmPath))
    } catch {
      return { findings: [], scanned: 0, skipped: 'node_modules 不存在或不可读' }
    }
    const byName = new Map<string, { name: string; scripts: { script: string; command: string }[] }>()
    let scanned = 0
    const MAX = 600
    const record = (name: string, pj: Record<string, unknown> | null): void => {
      if (byName.has(name)) return
      const s = this.scriptsOf(pj)
      if (s.length > 0) byName.set(name, { name, scripts: s })
    }
    for (const e of entries) {
      if (scanned >= MAX) break
      const base = nmPath + '/' + e.name
      if (e.name.startsWith('@')) {
        let sub
        try { sub = await this.ctx.fs.listDir(await this.ctx.fs.resolve(base)) } catch { continue }
        for (const se of sub) {
          if (scanned >= MAX) break
          record(e.name + '/' + se.name, await this.readJson(base + '/' + se.name + '/package.json'))
          scanned++
        }
      } else if (!e.name.startsWith('.')) {
        record(e.name, await this.readJson(base + '/package.json'))
        scanned++
      }
    }
    let pnpm
    try { pnpm = await this.ctx.fs.listDir(await this.ctx.fs.resolve(nmPath + '/.pnpm')) } catch { pnpm = [] }
    for (const pe of pnpm) {
      if (scanned >= MAX) break
      const innerDir = nmPath + '/.pnpm/' + pe.name + '/node_modules'
      let inner
      try { inner = await this.ctx.fs.listDir(await this.ctx.fs.resolve(innerDir)) } catch { continue }
      for (const ie of inner) {
        if (scanned >= MAX) break
        if (ie.name.startsWith('@')) {
          try {
            const scoped = await this.ctx.fs.listDir(await this.ctx.fs.resolve(innerDir + '/' + ie.name))
            for (const sk of scoped) {
              if (scanned >= MAX) break
              record(ie.name + '/' + sk.name, await this.readJson(innerDir + '/' + ie.name + '/' + sk.name + '/package.json'))
              scanned++
            }
          } catch { continue }
        } else {
          record(ie.name, await this.readJson(innerDir + '/' + ie.name + '/package.json'))
          scanned++
        }
      }
    }
    return { findings: [...byName.values()], scanned, skipped: scanned >= MAX ? `已扫描上限 ${MAX} 个包` : '' }
  }

  private async fetchJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.ctx.web.fetch({ url })
      if (res.statusCode < 200 || res.statusCode >= 300) return null
      const text = res.body?.content ?? ''
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private async fetchReputation(names: string[]): Promise<{ items: DepsecFinding[]; truncated: boolean }> {
    const out: DepsecFinding[] = []
    const MAX = 25
    const now = Date.now()
    for (let i = 0; i < names.length && i < MAX; i++) {
      const name = names[i]
      const enc = name.replace('/', '%2F')
      const meta = await this.fetchJson('https://registry.npmjs.org/' + enc)
      const dl = await this.fetchJson('https://api.npmjs.org/downloads/point/last-month/' + enc)
      if (meta === null) { out.push({ kind: 'registry 不可达', name, detail: '无法获取元数据', severity: 'info' }); continue }
      const time = meta.time as Record<string, string> | undefined
      const created = time?.created
      const daysAgo = created ? Math.floor((now - Date.parse(created)) / 86400000) : null
      const downloads = dl && typeof dl.downloads === 'number' ? dl.downloads : null
      const distTags = meta['dist-tags'] as Record<string, string> | undefined
      const latest = distTags?.latest
      const versions = meta.versions as Record<string, unknown> | undefined
      const latestScripts = latest && versions?.[latest] ? this.scriptsOf(versions[latest] as Record<string, unknown>) : []
      const hasInstall = latestScripts.length > 0
      const isNew = daysAgo !== null && daysAgo < 30
      const lowDownloads = downloads !== null && downloads < 100
      const noRepo = !meta.repository
      const reasons: string[] = []
      if (hasInstall) reasons.push('含 install 脚本')
      if (isNew) reasons.push('发布不足 30 天')
      if (lowDownloads) reasons.push('月下载量 < 100')
      if (noRepo) reasons.push('无 repository 信息')
      let severity = 'info'
      if (hasInstall && (isNew || lowDownloads)) severity = 'high'
      else if (hasInstall || isNew) severity = 'medium'
      else if (lowDownloads) severity = 'low'
      out.push({ kind: '信誉告警', name, detail: reasons.length > 0 ? reasons.join('；') + `（发布 ${daysAgo ?? '?'} 天前，月下载 ${downloads ?? '?'}）` : '', severity })
    }
    return { items: out, truncated: names.length > MAX }
  }

  private parseNpm(text: string): { total: number; critical: number; high: number; moderate: number; low: number; info: number; list: DepsecVulnerability[] } | null {
    let data: Record<string, unknown>
    try { data = JSON.parse(text) as Record<string, unknown> } catch { return null }
    const advisories = data.advisories
    const vulnerabilities = data.vulnerabilities
    const hasAdvisories = advisories !== null && typeof advisories === 'object'
    const hasVulns = vulnerabilities !== null && typeof vulnerabilities === 'object'
    if (!hasAdvisories && !hasVulns) return null
    const list: DepsecVulnerability[] = []
    if (hasAdvisories) {
      for (const key of Object.keys(advisories as object)) {
        const a = (advisories as Record<string, unknown>)[key]
        if (a === null || typeof a !== 'object') continue
        const adv = a as Record<string, unknown>
        list.push({
          name: (adv.module_name as string) ?? key,
          severity: normSeverity(adv.severity),
          range: (adv.vulnerable_versions as string) ?? '',
          title: (adv.title as string) ?? '',
          url: (adv.url as string) ?? '',
          fixAvailable: Boolean(adv.patched_versions),
        })
      }
    } else {
      for (const key of Object.keys(vulnerabilities as object)) {
        const v = (vulnerabilities as Record<string, unknown>)[key]
        if (v === null || typeof v !== 'object') continue
        const vv = v as Record<string, unknown>
        let title = ''
        let url = ''
        const via = Array.isArray(vv.via) ? vv.via : []
        for (const x of via) {
          if (x && typeof x === 'object' && (x as Record<string, unknown>).url) {
            title = ((x as Record<string, unknown>).title as string) ?? ''
            url = ((x as Record<string, unknown>).url as string) ?? ''
            break
          }
        }
        list.push({
          name: (vv.name as string) ?? key,
          severity: normSeverity(vv.severity),
          direct: vv.isDirect === true,
          range: (vv.range as string) ?? '',
          title,
          url,
          fixAvailable: vv.fixAvailable === true || (vv.fixAvailable !== null && typeof vv.fixAvailable === 'object'),
        })
      }
    }
    const counts: Record<string, number> = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 }
    for (const f of list) counts[f.severity] = (counts[f.severity] ?? 0) + 1
    return { total: list.length, critical: counts.critical, high: counts.high, moderate: counts.moderate, low: counts.low, info: counts.info, list: list.slice(0, 100) }
  }

  private parseResult(manager: string, stdout: string) {
    if (manager === 'npm' || manager === 'pnpm' || manager === 'yarn') return this.parseNpm(stdout)
    return null
  }

  private isCandidateFile(name: string): boolean {
    const lower = name.toLowerCase()
    if (CANDIDATE_EXTS.some((e) => lower.endsWith(e))) return true
    if (lower === 'dockerfile' || lower === 'makefile' || lower === '.env' || lower === '.envrc') return true
    return /secret|credential|token|password|\.pem|\.key|id_rsa|id_ed25519/.test(lower)
  }

  private async scanPatterns(root: string, patterns: Pattern[], label: string, withEntropy: boolean): Promise<{ findings: DepsecFinding[]; scanned: number; skipped: string }> {
    const findings: DepsecFinding[] = []
    let scanned = 0
    const MAX = 1500
    const stack = [root]
    while (stack.length > 0 && scanned < MAX) {
      const dir = stack.pop()!
      let entries
      try { entries = await this.ctx.fs.listDir(await this.ctx.fs.resolve(dir)) } catch { continue }
      for (const e of entries) {
        if (scanned >= MAX) break
        if (SKIP_DIRS.includes(e.name)) continue
        const p = dir + '/' + e.name
        if (e.type === 'directory') {
          stack.push(p)
        } else if (e.type === 'file' && this.isCandidateFile(e.name)) {
          scanned++
          try {
            const t: FsTarget = await this.ctx.fs.resolve(p)
            const info = await this.ctx.fs.stat(t)
            if (info === undefined || info.type !== 'file') continue
            if (info.size !== undefined && info.size > 262144) continue
            const text = await this.ctx.fs.readText(t)
            const lines = text.split('\n')
            for (let li = 0; li < lines.length; li++) {
              const line = lines[li]
              if (line.length > 1200) continue
              let hit = false
              for (const pattern of patterns) {
                const m = line.match(pattern.regex)
                if (m) {
                  findings.push({ kind: label, name: pattern.name, file: p, line: li + 1, detail: line.replace(m[0], '***').slice(0, 140), severity: pattern.severity })
                  hit = true
                  break
                }
              }
              if (!hit && withEntropy) {
                const tokens = line.match(/[A-Za-z0-9+/_-]{32,64}/g)
                if (tokens) {
                  for (const tok of tokens) {
                    if (looksRandom(tok) && shannonEntropy(tok) > 4.3) {
                      findings.push({ kind: label, name: '高熵随机串', file: p, line: li + 1, detail: '***' + tok.slice(-4), severity: 'low' })
                      hit = true
                      break
                    }
                  }
                }
              }
              if (findings.length >= 300) break
            }
          } catch {
            /* skip binary/unreadable */
          }
        }
      }
    }
    return { findings, scanned, skipped: scanned >= MAX ? `已扫描上限 ${MAX} 个文件` : '' }
  }

  private async scanGitHistory(root: string, patterns: Pattern[]): Promise<{ findings: DepsecFinding[]; commits: number; note: string }> {
    const run = await this.runCommand('git log --all -p -U0 -n 20 --format="@@%H" --diff-filter=AM', root)
    if (run.exitCode !== 0) return { findings: [], commits: 0, note: '' }
    const findings: DepsecFinding[] = []
    let commit = ''
    let file = ''
    let commits = 0
    for (const line of run.stdout.split('\n')) {
      if (line.startsWith('@@') && line.length >= 42) { commit = line.slice(2, 42); commits++; continue }
      if (line.startsWith('+++ b/')) { file = line.slice(6); continue }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        if (line.length > 1200) continue
        for (const pattern of patterns) {
          const m = line.match(pattern.regex)
          if (m) {
            findings.push({ kind: '密钥(git历史)', name: pattern.name, file: file ? this.joinPath(root, file) : root, commit: commit.slice(0, 8), line: 0, detail: (commit ? 'commit ' + commit.slice(0, 8) + ' · ' : '') + line.slice(1).replace(m[0], '***').slice(0, 120), severity: pattern.severity })
            break
          }
        }
        if (findings.length >= 100) break
      }
    }
    return { findings, commits, note: commits > 0 ? `已扫描最近 ${commits} 个提交` : '' }
  }

  private async readIgnores(root: string): Promise<string[]> {
    const t = await this.readTextFile(this.joinPath(root, '.depsecignore'))
    if (t === null) return []
    return t.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'))
  }

  private applyIgnores(findings: DepsecFinding[], ignores: string[]): DepsecFinding[] {
    if (ignores.length === 0) return findings
    return findings.filter((f) => {
      const hay = `${f.file ?? ''} ${f.name ?? ''} ${f.kind ?? ''}`
      return !ignores.some((ig) => hay.includes(ig))
    })
  }

  private findingKey(scope: DepsecScope, f: DepsecFinding | DepsecVulnerability): string {
    if (scope === 'vuln') return 'v:' + (f.name ?? '') + ':' + (f.severity ?? '')
    return 'f:' + ((f as DepsecFinding).file ?? '') + ':' + ((f as DepsecFinding).line ?? 0) + ':' + ((f as DepsecFinding).kind ?? '') + ':' + (f.name ?? '')
  }

  private markNew(scope: DepsecScope, list: (DepsecFinding | DepsecVulnerability)[]): number {
    const prev = this.baseline.get(scope) ?? new Set<string>()
    const curr = new Set<string>()
    let n = 0
    for (const f of list) {
      const k = this.findingKey(scope, f)
      curr.add(k)
      f.isNew = !prev.has(k)
      if (f.isNew) n++
    }
    this.baseline.set(scope, curr)
    return n
  }

  private async runSupplyChain(root: string): Promise<DepsecResult> {
    const det = await this.detectManager(root)
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(det.manager)) {
      return { ok: false, scope: 'supply-chain', root, manager: det.manager, verdict: 'clean', message: '供应链/投毒扫描当前支持 npm 系项目（需 package.json）' }
    }
    const pkg = await this.readJson(this.joinPath(root, 'package.json'))
    if (pkg === null) return { ok: false, scope: 'supply-chain', root, manager: det.manager, verdict: 'clean', message: '无法读取 package.json' }
    const depMap = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) }
    const depNames = Object.keys(depMap)
    const projScripts = this.scriptsOf(pkg)
    const nm = await this.scanNodeModules(root)
    const typos = this.typosquatting(depNames)
    const rep = await this.fetchReputation(depNames)

    let findings: DepsecFinding[] = []
    for (const s of projScripts) findings.push({ kind: '项目 install 脚本', name: (pkg.name as string) ?? '(root)', detail: `${s.script}: ${s.command}`, severity: 'high' })
    for (const f of nm.findings) {
      for (const s of f.scripts) findings.push({ kind: '依赖 install 脚本', name: f.name, detail: `${s.script}: ${s.command}`, severity: 'high' })
    }
    findings.push(...typos)
    findings.push(...rep.items)
    const ignores = await this.readIgnores(root)
    findings = this.applyIgnores(findings, ignores)
    const newCount = this.markNew('supply-chain', findings)
    const counts: Record<string, number> = { high: 0, medium: 0, low: 0, info: 0 }
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
    const summary: DepsecSummary = { total: findings.length, high: counts.high, medium: counts.medium, low: counts.low, info: counts.info, newCount }
    return {
      ok: true, scope: 'supply-chain', root, manager: det.manager, verdict: verdictOf(summary),
      project: { name: (pkg.name as string) ?? '', version: (pkg.version as string) ?? '', depCount: depNames.length },
      summary, findings: findings.slice(0, 200),
      stats: { nodeModulesScanned: nm.scanned, reputationScanned: rep.items.length, reputationTruncated: rep.truncated ? 1 : 0 },
      note: [nm.skipped, rep.truncated ? '直接依赖超过 25 个，仅对前 25 个做联网信誉检查' : ''].filter(Boolean).join('；'),
    }
  }

  private async runVuln(root: string): Promise<DepsecResult> {
    let det
    try { det = await this.detectManager(root) } catch (e) { return { ok: false, detected: false, scope: 'vuln', manager: null, root, verdict: 'clean', error: e instanceof Error ? e.message : String(e) } }
    if (det.manager === 'unknown') return { ok: false, detected: false, scope: 'vuln', manager: null, root, verdict: 'clean', message: '未检测到受支持的包管理器清单' }
    const command = COMMANDS[det.manager]
    if (command === null || command === undefined) return { ok: false, detected: true, scope: 'vuln', manager: det.manager, root, verdict: 'clean', message: 'bun 暂无官方 audit 命令' }
    const run = await this.runCommand(command, root)
    const parsed = this.parseResult(det.manager, run.stdout)
    if (parsed === null) {
      const needle = run.stderr + ' ' + run.stdout
      const toolMissing = /not found|not recognized|无法识别|command not found|No such file|ENOENT/i.test(needle) || (run.exitCode !== 0 && run.stdout.trim().length === 0)
      return {
        ok: false, detected: true, scope: 'vuln', manager: det.manager, root, verdict: 'clean', command, exitCode: run.exitCode,
        error: toolMissing ? `审计工具未安装或不可用：请确认 \`${command.split(' ')[0]}\` 已安装并位于 PATH 中。` : `未能解析审计输出（退出码 ${run.exitCode}）。`,
        stderrTail: run.stderr.slice(0, 2000), stdoutTail: run.stdout.slice(0, 2000),
      }
    }
    const newCount = this.markNew('vuln', parsed.list)
    const summary: DepsecSummary = { total: parsed.total, critical: parsed.critical, high: parsed.high, moderate: parsed.moderate, low: parsed.low, info: parsed.info, newCount }
    return { ok: true, detected: true, scope: 'vuln', manager: det.manager, root, verdict: verdictOf(summary), command, exitCode: run.exitCode, timedOut: run.timedOut, summary, vulnerabilities: parsed.list, note: run.timedOut ? '审计超时（命令超过 120 秒被终止），结果可能不完整。' : '' }
  }

  private async runSecrets(root: string): Promise<DepsecResult> {
    const wt = await this.scanPatterns(root, SECRET_PATTERNS, '密钥', true)
    const hist = await this.scanGitHistory(root, SECRET_PATTERNS)
    const ignores = await this.readIgnores(root)
    let findings = this.applyIgnores([...wt.findings, ...hist.findings], ignores)
    const newCount = this.markNew('secrets', findings)
    const counts: Record<string, number> = { high: 0, medium: 0, low: 0, info: 0 }
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
    const summary: DepsecSummary = { total: findings.length, high: counts.high, medium: counts.medium, low: counts.low, info: counts.info, newCount }
    return { ok: true, scope: 'secrets', root, verdict: verdictOf(summary), summary, findings: findings.slice(0, 200), stats: { filesScanned: wt.scanned, historyCommits: hist.commits }, note: [wt.skipped, hist.note].filter(Boolean).join('；') }
  }

  private async runSast(root: string): Promise<DepsecResult> {
    const wt = await this.scanPatterns(root, SAST_PATTERNS, '代码', false)
    const ignores = await this.readIgnores(root)
    const findings = this.applyIgnores(wt.findings, ignores)
    const newCount = this.markNew('sast', findings)
    const counts: Record<string, number> = { high: 0, medium: 0, low: 0, info: 0 }
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
    const summary: DepsecSummary = { total: findings.length, high: counts.high, medium: counts.medium, low: counts.low, info: counts.info, newCount }
    return { ok: true, scope: 'sast', root, verdict: verdictOf(summary), summary, findings: findings.slice(0, 200), stats: { filesScanned: wt.scanned }, note: wt.skipped }
  }

  private async runScope(root: string, scope: DepsecScope): Promise<DepsecResult> {
    if (scope === 'supply-chain') return await this.runSupplyChain(root)
    if (scope === 'secrets') return await this.runSecrets(root)
    if (scope === 'sast') return await this.runSast(root)
    return await this.runVuln(root)
  }

  private buildSarif(result: DepsecResult) {
    const findings = result.findings ?? result.vulnerabilities ?? []
    const rules: { id: string; name: string; shortDescription: { text: string } }[] = []
    const ruleIndex: Record<string, number> = {}
    const results: { ruleId: string; level: string; message: { text: string }; locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[] }[] = []
    for (const f of findings) {
      const base = f.name ?? f.kind ?? 'finding'
      const ruleId = String(base).replace(/[^A-Za-z0-9.-]+/g, '-')
      if (ruleIndex[ruleId] === undefined) {
        ruleIndex[ruleId] = rules.length
        rules.push({ id: ruleId, name: base, shortDescription: { text: base } })
      }
      const f2 = f as DepsecFinding
      const loc = f2.file ? [{ physicalLocation: { artifactLocation: { uri: f2.file }, region: { startLine: f2.line ?? 1 } } }] : []
      results.push({ ruleId, level: f.severity === 'critical' || f.severity === 'high' ? 'error' : f.severity === 'medium' || f.severity === 'moderate' ? 'warning' : 'note', message: { text: `${f2.kind ? f2.kind + ': ' : ''}${f.name ?? ''}${f2.detail ? ' — ' + f2.detail : ''}` }, locations: loc })
    }
    return { $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{ tool: { driver: { name: 'depsec', informationUri: 'https://awesome-dsh-plugin.com', rules } }, results }] }
  }

  private async notifyWindows(title: string, text: string): Promise<void> {
    const sTitle = String(title).replace(/['"`\r\n\t]/g, ' ').trim()
    const sText = String(text).replace(/['"`\r\n\t]/g, ' ').trim()
    if (sText.length === 0) return
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Warning; $n.BalloonTipTitle="${sTitle}"; $n.BalloonTipText="${sText}"; $n.Visible=$true; $n.ShowBalloonTip(4000); Start-Sleep -Milliseconds 4500; $n.Dispose()`
    try {
      const spec = this.ctx.shell.resolve({ command: `powershell -NoProfile -NonInteractive -Command '${script}'`, timeoutMs: 20000 } as ShellExecRequest)
      await this.ctx.shell.run(spec)
    } catch {
      /* best-effort */
    }
  }

  private async smartNotify(r: DepsecResult): Promise<void> {
    if (!r.ok || r.verdict !== 'critical') return
    const s = r.summary
    await this.notifyWindows('依赖安全审计', `发现 ${(s?.critical ?? 0) + (s?.high ?? 0)} 个高危问题（${r.scope}）`)
  }

  private async notifyFor(r: DepsecResult): Promise<void> {
    const s = r.summary
    const newTxt = s?.newCount ? `（新增 ${s.newCount}）` : ''
    const label = r.scope === 'supply-chain' ? '投毒扫描' : r.scope === 'secrets' ? '密钥扫描' : r.scope === 'sast' ? '代码扫描' : '漏洞审计'
    if (!r.ok) { await this.notifyWindows('依赖安全审计', `${label}未完成：${r.message ?? r.error ?? '未知错误'}`); return }
    const verdictTxt = r.verdict === 'critical' ? '🔴 ' : r.verdict === 'warning' ? '🟡 ' : '🟢 '
    await this.notifyWindows('依赖安全审计', `${verdictTxt}${label}：${s?.total ?? 0} 个${newTxt}`)
  }

  private async autoScanAfterInstall(agent: Agent | undefined): Promise<void> {
    const now = Date.now()
    if (now - this.lastAutoAt < 15000) return
    this.lastAutoAt = now
    const root = this.rootOfAgent(agent)
    if (root === undefined) return
    const result = await this.runSupplyChain(root)
    this.monitoringState = { at: now, scope: 'supply-chain', verdict: result.verdict, total: result.summary?.total, high: result.summary?.high }
    await this.smartNotify(result)
  }

  private async runAudit(path: string | undefined, scope: DepsecScope): Promise<DepsecResult> {
    const root = this.rootFor(path)
    if (root === undefined) return { ok: false, detected: false, manager: null, verdict: 'clean', error: '无法确定工作区根目录（sandboxPolicy 服务不可用）' }
    const result = await this.runScope(root, scope)
    await this.notifyFor(result)
    return result
  }

  private renderText(r: DepsecResult): string {
    const s = r.summary
    if (!r.ok) return `${r.message ?? r.error ?? '扫描未完成'}`
    if (r.scope === 'vuln') {
      const vulns = r.vulnerabilities ?? []
      const lines = [`漏洞审计结果：${r.manager}`, `漏洞统计：总计 ${s?.total ?? 0}（新增 ${s?.newCount ?? 0}）；critical ${s?.critical ?? 0}，high ${s?.high ?? 0}，moderate ${s?.moderate ?? 0}，low ${s?.low ?? 0}`]
      for (const v of vulns) lines.push(`- [${v.severity}] ${v.name}${v.range ? ' ' + v.range : ''}${v.fixAvailable ? ' (可修复)' : ''}`)
      return lines.join('\n')
    }
    const findings = r.findings ?? []
    const lines = [`${r.scope} 扫描结果`, `告警统计：总计 ${s?.total ?? 0}（新增 ${s?.newCount ?? 0}）；high ${s?.high ?? 0}，medium ${s?.medium ?? 0}，low ${s?.low ?? 0}，info ${s?.info ?? 0}`]
    for (const f of findings) lines.push(`- [${f.severity}] ${f.name}${f.file ? ' · ' + f.file + ':' + f.line : ''}${f.detail ? ' · ' + f.detail : ''}`)
    return lines.join('\n')
  }
}

export default DepsecService
