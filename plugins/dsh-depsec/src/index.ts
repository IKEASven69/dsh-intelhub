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
  BlockVerdict,
  DepsecFinding,
  DepsecResult,
  DepsecScope,
  DepsecSummary,
  DepsecVulnerability,
  FixRequest,
  FixResult,
  MonitorState,
  OpenFileRequest,
  PluginRosterEntry,
  PluginRosterResult,
  SarifResult,
  WriteApprovalsRequest,
  WriteApprovalsResult,
} from './types.ts'
import { parseCargoAudit, parseGoVulncheck, parsePipAudit } from './vuln-parsers.ts'

import { analyzeInstallScript, referencedScriptFiles, renderSignals } from './script-analysis.ts'
import { mergeAllowBuildsYaml, mergeAllowScriptsDoc, parseAllowBuildsYaml } from './trust-writeback.ts'
import { slopsquatFinding, typosquatFindings } from './trust-signals.ts'
import { appendHistory, diffTrustRecord, filesFingerprint, mergeTrustRecord, scriptsFingerprint } from './trust-record.ts'
import type { AuditHistoryEntry, TrustRecord } from './trust-record.ts'
import { isModelFacingFile, scanInjectedText } from './prompt-injection.ts'

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

/**
 * 三档闸门语义：与 dsh-market / dsh-plugin-gate 对齐。
 * 任何 critical 或 high 都升档为 block；中/低/未知为 warn；没有任何信号为 pass。
 * 旧 verdict 字段保留以兼容既有基线和告警 UI 文本；新 UI 与 SARIF 优先消费此字段。
 */
function blockVerdictOf(summary?: DepsecSummary): BlockVerdict {
  if (!summary) return 'pass'
  if ((summary.critical ?? 0) > 0 || (summary.high ?? 0) > 0) return 'block'
  if ((summary.total ?? 0) > 0) return 'warn'
  return 'pass'
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
  async audit(request: AuditRequest): Promise<DepsecResult> {
    return await this.runAudit(request.path, request.scope ?? 'vuln')
  }

  @Remote('audit-fix')
  async auditFix(request: FixRequest): Promise<FixResult> {
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
  async exportSarif(request: AuditRequest): Promise<SarifResult> {
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

  @Remote('write-approvals')
  async writeApprovals(request: WriteApprovalsRequest): Promise<WriteApprovalsResult> {
    const root = this.rootFor(request.path)
    if (root === undefined) return { ok: false, error: '无法确定工作区根目录' }
    let packages = request.packages
    if (packages === undefined || packages.length === 0) {
      const scan = await this.runSupplyChain(root)
      if (!scan.ok) return { ok: false, error: scan.message ?? scan.error ?? '扫描失败，无法计算放行清单' }
      packages = scan.approvals ?? []
    }
    const pkgPath = this.joinPath(root, 'package.json')
    const doc = await this.readJson(pkgPath)
    if (doc === null) return { ok: false, error: '无法读取 package.json' }
    // pnpm 11：allowBuilds 在工作区根的 pnpm-workspace.yaml；缺文件视为空表（写入时创建）
    const wsPath = this.joinPath(root, 'pnpm-workspace.yaml')
    const wsText = await this.readTextFile(wsPath)
    const wsParse = parseAllowBuildsYaml(wsText ?? undefined)
    if (!wsParse.ok) return { ok: false, error: `pnpm-workspace.yaml 的 allowBuilds 块形态未知，已放弃写入（${wsParse.error}）` }

    const pnpmField = (doc.pnpm as Record<string, unknown> | undefined) ?? {}
    const allowScriptsField = (doc.allowScripts as Record<string, unknown> | undefined) ?? {}
    const existing = new Set<string>([
      ...((pnpmField.onlyBuiltDependencies as string[] | undefined) ?? []),
      ...((doc.trustedDependencies as string[] | undefined) ?? []),
      ...[...wsParse.entries].filter(([, v]) => v === true).map(([k]) => k),
      ...Object.entries(allowScriptsField)
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    ])
    // 显式拒绝（false）是用户的决定：不翻转、不入任何放行清单
    const denied = [...new Set(packages)].filter(
      (p) => allowScriptsField[p] === false || wsParse.entries.get(p) === false,
    )
    const wanted = [...new Set(packages)].filter((p) => !denied.includes(p))
    const added = wanted.filter((p) => !existing.has(p)).sort()
    const targets = [
      'package.json：pnpm.onlyBuiltDependencies（pnpm 10）+ allowScripts（npm 12）+ trustedDependencies（bun）',
      'pnpm-workspace.yaml：allowBuilds（pnpm 11）',
    ]
    if (added.length === 0) {
      return { ok: true, added: [], existing: [...existing].sort(), total: existing.size, denied, note: '放行清单已是最新。' }
    }
    if (request.dryRun === true) {
      return { ok: true, added, existing: [...existing].sort(), total: existing.size + added.length, denied, targets, note: 'dryRun：仅计算，未写入。' }
    }
    const merged = [...new Set([...existing, ...wanted])].sort()
    const wb = mergeAllowBuildsYaml(wsText ?? undefined, wanted)
    if (!wb.ok) return { ok: false, error: `pnpm-workspace.yaml 写入放弃：${wb.error}` }
    const as = mergeAllowScriptsDoc(doc, wanted)
    const next: Record<string, unknown> = {
      ...as.doc,
      pnpm: { ...(as.doc.pnpm as Record<string, unknown> | undefined), onlyBuiltDependencies: merged },
      trustedDependencies: merged,
    }
    try {
      await this.ctx.fs.writeText(await this.ctx.fs.resolve(pkgPath), JSON.stringify(next, null, 2) + '\n')
      await this.ctx.fs.writeText(await this.ctx.fs.resolve(wsPath), wb.text!)
    } catch (e) {
      return { ok: false, error: `写回失败：${e instanceof Error ? e.message : String(e)}` }
    }
    return {
      ok: true,
      added,
      existing: merged,
      total: merged.length,
      denied,
      targets,
      note: `已写入 package.json（pnpm.onlyBuiltDependencies / allowScripts / trustedDependencies（bun））与 pnpm-workspace.yaml（allowBuilds），共 ${merged.length} 项。仅自动放行「脚本全 PASS 且无其他中高危信号」的包；WARN/BLOCK 不会入单${denied.length > 0 ? `；${denied.length} 项显式拒绝（false）保持拒绝` : ''}。`,
    }
  }

  @Remote('monitor-status')
  async monitorStatus(): Promise<MonitorState | null> {
    return this.monitoringState
  }

  @Remote('scan-installed-plugins')
  async scanInstalledPlugins(request: { profile?: string }): Promise<PluginRosterResult> {
    // 优先用 client 显式传过来的 profile 路径——这是 dsh sandbox workspace-write
    // 模式下唯一可靠的入口（plugin 不能主动访问 ~/.dsh，因为它不在 workspace 根下）。
    // fallback：defaultProfileRoot()（也可能被 sandbox 拦）→ currentRoot()（workspace 根）。
    //
    // 背景：currentRoot() 给的是 dsh workspace 根（用户当前项目），不是 profile 根
    // （`~/.dsh/profiles/<name>` 是装插件的地方）。直接用 workspaceRoot 会扫不到任何
    // 已装插件——profile 和 workspace 是两棵不同的目录树。
    let root = request.profile
    if (root === undefined || root === '') {
      root = await this.defaultProfileRoot()
    }
    if (root === undefined) {
      root = this.currentRoot()
    }
    if (root === undefined) {
      return { ok: false, scope: 'plugin-roster', profile: '', total: 0, plugins: [], error: '无法确定 profile 根目录（请在输入框里填 ~/.dsh/profiles/<name>）' }
    }
    // 调试：把推断过程写到 monitoringState + note 里
    const env = process.env as Record<string, string | undefined>
    const dbg = `cwd=${process.cwd()} USERPROFILE=${env.USERPROFILE ?? 'undef'} DSH_HOME=${env.DSH_HOME ?? 'undef'} HOME=${env.HOME ?? 'undef'} HOMEDRIVE=${env.HOMEDRIVE ?? 'undef'} HOMEPATH=${env.HOMEPATH ?? 'undef'} request=${JSON.stringify(request.profile)} default=${JSON.stringify(await this.defaultProfileRoot())} current=${JSON.stringify(this.currentRoot())} resolved=${root}`
    this.monitoringState = {
      at: Date.now(),
      scope: 'plugin-roster',
      note: dbg,
    }
    const bundles = await this.listProfileBundles(root)
    const plugins: PluginRosterEntry[] = []
    // 插件哈希锁：本 profile 全部插件的文件指纹记录（与依赖 version lock 同一套 trust-record 语义）
    const prevPluginRecord = await this.loadTrustRecord(root, 'pluginRecord')
    const pluginObserved: TrustRecord = {}
    for (const b of bundles) {
      // 每个插件跑 supply-chain + secrets + sast + prompt-injection（vuln 跳过——插件的依赖不一定
      // 在 npm 体系下管理；直接跑它的 node_modules 意义不大）
      const sc = await this.runSupplyChain(b.dir)
      const secrets = await this.runSecrets(b.dir)
      const sast = await this.runSast(b.dir)
      const findings: DepsecFinding[] = []
      for (const f of sc.findings ?? []) findings.push(f)
      for (const f of secrets.findings ?? []) findings.push(f)
      for (const f of sast.findings ?? []) findings.push(f)

      // v0.5 模型面文本：SKILL.md/commands/agents 的提示注入内容检测 + egress 目的地清单
      const modelFiles = await this.collectModelFacingFiles(b.dir)
      const INJ_RANK = { pass: 0, warn: 1, block: 2 }
      let injVerdict: 'pass' | 'warn' | 'block' = 'pass'
      const egressAll = new Set<string>()
      for (const f of modelFiles) {
        const r = scanInjectedText(f.rel, f.text)
        if (INJ_RANK[r.verdict] > INJ_RANK[injVerdict]) injVerdict = r.verdict
        for (const h of r.egress) egressAll.add(h)
        for (const fd of r.findings) {
          if (fd.severity === 'low') continue
          findings.push({
            kind: '插件提示注入',
            name: `${b.name}/${f.rel}`,
            detail: `${fd.category}/${fd.severity} L${fd.line}${fd.via !== undefined ? `（via ${fd.via}）` : ''}｜${fd.snippet}`,
            severity: fd.severity === 'critical' || (fd.severity === 'high' && r.verdict === 'block') ? 'high' : 'medium',
          })
        }
      }
      // egress 分级：已知分发/主流 AI 厂商域名之外的 host 才出 finding
      const KNOWN = await import('./script-analysis.ts').then((m) => m.KNOWN_DOWNLOAD_HOSTS)
      const unknownEgress = [...egressAll].filter((h) => !KNOWN.has(h) && !/^(?:api\.)?(?:deepseek|openai|anthropic|googleapis|mistral|x\.ai)\b/.test(h) && !/\.npmmirror\.com$/.test(h))
      if (unknownEgress.length > 0) {
        findings.push({
          kind: '插件外联目的地',
          name: b.name,
          detail: `模型面文本外联 ${unknownEgress.length} 个非白名单 host（装前知情）：${unknownEgress.slice(0, 10).join(', ')}`,
          severity: 'low',
        })
      }

      // 哈希锁：模型面文件 + package.json 指纹；变了 → 重审 finding
      const fpFiles = modelFiles.map((f) => ({ path: f.rel, content: f.text }))
      const pkgJson = await this.readJson(this.joinPath(b.dir, 'package.json'))
      if (pkgJson !== null) fpFiles.push({ path: 'package.json', content: JSON.stringify(pkgJson) })
      const pluginFp = filesFingerprint(fpFiles)
      for (const c of diffTrustRecord(prevPluginRecord, { [b.name]: { version: b.version, fingerprint: pluginFp } })) {
        findings.push({
          kind: '已装插件文件变更',
          name: b.name,
          detail: `自上次 roster 扫描后文件内容变化（版本 ${c.fromVersion} → ${c.toVersion}）：装后篡改/热更新路径，原审计结论失效，建议重扫`,
          severity: 'medium',
        })
      }
      pluginObserved[b.name] = { version: b.version, fingerprint: pluginFp, verdict: injVerdict === 'block' ? 'block' : injVerdict === 'warn' ? 'warn' : 'pass', scripts: [], at: new Date().toISOString() }

      plugins.push({
        name: b.name,
        version: b.version,
        dir: b.dir,
        manager: b.manager,
        verdicts: {
          supplyChain: (sc.blockVerdict ?? 'pass'),
          secrets: (secrets.blockVerdict ?? 'pass'),
          sast: (sast.blockVerdict ?? 'pass'),
          promptInjection: injVerdict,
        },
        findings,
        egress: [...egressAll].sort(),
        note: `supply-chain ${sc.blockVerdict ?? 'pass'} / secrets ${secrets.blockVerdict ?? 'pass'} / sast ${sast.blockVerdict ?? 'pass'} / 提示注入 ${injVerdict}（模型面文件 ${modelFiles.length} 个）`,
      })
    }
    await this.saveTrustRecord(root, mergeTrustRecord(prevPluginRecord, pluginObserved, new Date().toISOString()), 'pluginRecord')
    // 排序：block 优先，warn 次之，pass 末尾
    const rank = (v: BlockVerdict): number => v === 'block' ? 0 : v === 'warn' ? 1 : 2
    plugins.sort((a, b) => {
      const wa = Math.min(rank(a.verdicts.supplyChain), rank(a.verdicts.secrets), rank(a.verdicts.sast), rank(a.verdicts.promptInjection))
      const wb = Math.min(rank(b.verdicts.supplyChain), rank(b.verdicts.secrets), rank(b.verdicts.sast), rank(b.verdicts.promptInjection))
      return wa - wb
    })
    return {
      ok: true,
      scope: 'plugin-roster',
      profile: root,
      total: plugins.length,
      plugins,
      note: `已扫描 ${plugins.length} 个 bundle；按最严重维度排序（block > warn > pass）\ndebug: ${dbg}`,
    }
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

  /**
   * 默认 profile 根路径：尝试从 $DSH_HOME/profiles/$DSH_PROFILE 推断。
   * dsh web 进程通常会透传这两个环境变量；如果都没有，回退到 $HOME/.dsh/profiles/web
   * （最常见的默认 profile 名）。
   */
  private async defaultProfileRoot(): Promise<string | undefined> {
    const env = process.env as Record<string, string | undefined>
    const candidates: string[] = []
    if (env.DSH_HOME !== undefined && env.DSH_HOME.length > 0) candidates.push(env.DSH_HOME)
    if (env.USERPROFILE !== undefined) candidates.push(`${env.USERPROFILE}/.dsh`)
    if (env.HOME !== undefined) candidates.push(`${env.HOME}/.dsh`)
    if (env.HOMEDRIVE !== undefined && env.HOMEPATH !== undefined) candidates.push(`${env.HOMEDRIVE}${env.HOMEPATH}/.dsh`)
    const profileName = env.DSH_PROFILE ?? 'web'
    const tried: string[] = []
    let lastErr = ''
    let hit: string | undefined
    for (const home of candidates) {
      const normalizedHome = home.replace(/\\/g, '/').replace(/[\\/]+$/, '')
      const profileDir = `${normalizedHome}/profiles/${profileName}`
      tried.push(profileDir)
      try {
        // 走 dsh 自己的 fs 抽象（this.ctx.fs），遵循 sandbox policy；
        // 比 require('node:fs') 稳。
        const target = await this.ctx.fs.resolve(profileDir)
        const info = await this.ctx.fs.stat(target)
        if (info !== undefined && info.type === 'directory') {
          tried[tried.length - 1] = `${profileDir} (EXISTS, type=${info.type})`
          hit = profileDir
          break
        }
        tried[tried.length - 1] = `${profileDir} (not dir, info=${info?.type ?? 'undef'})`
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        tried[tried.length - 1] = `${profileDir} (err: ${lastErr.slice(0, 80)})`
      }
    }
    this.monitoringState = {
      at: Date.now(),
      scope: 'plugin-roster',
      note: `defaultProfileRoot tried: ${tried.join(' | ')} | err: ${lastErr || 'none'} | hit: ${hit ?? 'none'}`,
    }
    return hit
  }

  /**
   * 列出 profile 里"装了的有 dsh bundle 的包"。
   *
   * 不依赖 cordis loader API（loader 不属于对外契约），用最朴素的策略：
   * 读 profile 的 node_modules/ 顶层，过滤出 package.json 声明了 dsh.bundle 的项。
   * pnpm 的 .pnpm/ 嵌套目录会被平展成包名（去掉平台前缀）；link:/file:/git: 源
   * 链接在 node_modules 里也是普通包目录，按相同规则扫描。
   *
   * @param root - profile root (通常来自 sandboxPolicy.workspaceRoot)
   * @returns 列表 [{ name, version, dir, manager }]
   */
  private async listProfileBundles(root: string): Promise<Array<{ name: string; version: string; dir: string; manager: PluginRosterResult['plugins'][number]['manager'] }>> {
    const out: Array<{ name: string; version: string; dir: string; manager: PluginRosterResult['plugins'][number]['manager'] }> = []
    let entries: Array<{ name: string; type?: string }> = []
    try {
      entries = await this.ctx.fs.listDir(await this.ctx.fs.resolve(root + '/node_modules'))
    } catch {
      return out
    }
    // 检测包管理器
    let manager: PluginRosterResult['plugins'][number]['manager'] = 'unknown'
    try {
      const det = await this.detectManager(root)
      manager = det.manager === 'npm' || det.manager === 'pnpm' || det.manager === 'yarn' || det.manager === 'bun'
        ? det.manager : 'unknown'
    } catch { /* keep unknown */ }

    const seen = new Set<string>()
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      // 处理 @scope/name
      if (e.name.startsWith('@')) {
        let sub: Array<{ name: string; type?: string }> = []
        try {
          sub = await this.ctx.fs.listDir(await this.ctx.fs.resolve(`${root}/node_modules/${e.name}`))
        } catch { continue }
        for (const se of sub) {
          const fullName = `${e.name}/${se.name}`
          if (seen.has(fullName)) continue
          seen.add(fullName)
          const pkg = await this.readJson(`${root}/node_modules/${fullName}/package.json`)
          if (pkg === null) continue
          const hasBundle = pkg.dsh !== undefined && typeof (pkg.dsh as Record<string, unknown>).bundle === 'object'
          if (!hasBundle) continue
          out.push({
            name: fullName,
            version: (pkg.version as string) ?? '',
            dir: `${root}/node_modules/${fullName}`,
            manager,
          })
        }
        continue
      }
      if (seen.has(e.name)) continue
      seen.add(e.name)
      const pkg = await this.readJson(`${root}/node_modules/${e.name}/package.json`)
      if (pkg === null) continue
      const hasBundle = pkg.dsh !== undefined && typeof (pkg.dsh as Record<string, unknown>).bundle === 'object'
      if (!hasBundle) continue
      out.push({
        name: e.name,
        version: (pkg.version as string) ?? '',
        dir: `${root}/node_modules/${e.name}`,
        manager,
      })
    }
    return out
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

  private async scanNodeModules(root: string): Promise<{ findings: { name: string; dir: string; scripts: { script: string; command: string }[] }[]; scanned: number; skipped: string }> {
    const nmPath = this.joinPath(root, 'node_modules')
    let entries
    try {
      entries = await this.ctx.fs.listDir(await this.ctx.fs.resolve(nmPath))
    } catch {
      return { findings: [], scanned: 0, skipped: 'node_modules 不存在或不可读' }
    }
    const byName = new Map<string, { name: string; dir: string; scripts: { script: string; command: string }[] }>()
    let scanned = 0
    const MAX = 600
    const record = (name: string, dir: string, pj: Record<string, unknown> | null): void => {
      if (byName.has(name)) return
      const s = this.scriptsOf(pj)
      if (s.length > 0) byName.set(name, { name, dir, scripts: s })
    }
    for (const e of entries) {
      if (scanned >= MAX) break
      const base = nmPath + '/' + e.name
      if (e.name.startsWith('@')) {
        let sub
        try { sub = await this.ctx.fs.listDir(await this.ctx.fs.resolve(base)) } catch { continue }
        for (const se of sub) {
          if (scanned >= MAX) break
          record(e.name + '/' + se.name, base + '/' + se.name, await this.readJson(base + '/' + se.name + '/package.json'))
          scanned++
        }
      } else if (!e.name.startsWith('.')) {
        record(e.name, base, await this.readJson(base + '/package.json'))
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
              record(ie.name + '/' + sk.name, innerDir + '/' + ie.name + '/' + sk.name, await this.readJson(innerDir + '/' + ie.name + '/' + sk.name + '/package.json'))
              scanned++
            }
          } catch { continue }
        } else {
          record(ie.name, innerDir + '/' + ie.name, await this.readJson(innerDir + '/' + ie.name + '/package.json'))
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
      let statusCode: number | null = null
      let meta: Record<string, unknown> | null = null
      try {
        const res = await this.ctx.web.fetch({ url: 'https://registry.npmjs.org/' + enc })
        statusCode = res.statusCode
        if (res.statusCode >= 200 && res.statusCode < 300) {
          meta = JSON.parse(res.body?.content ?? '') as Record<string, unknown>
        }
      } catch { statusCode = null }
      // 404 = registry 无此包名：slopsquatting（agent 幻觉包名被抢注）单列高危；其余非 2xx 才算「不可达」
      const sq = slopsquatFinding(name, statusCode)
      if (sq !== null) { out.push(sq); continue }
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
    if (manager === 'pip') return parsePipAudit(stdout)
    if (manager === 'cargo') return parseCargoAudit(stdout)
    if (manager === 'go') return parseGoVulncheck(stdout)
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

  /** 基线文件：<root>/.depsec-baseline.json（审计后自动更新，建议加入 .gitignore）。 */
  private baselinePath(root: string): string {
    return this.joinPath(root, '.depsec-baseline.json')
  }

  /** 版本锁记录与基线同文件（trustRecord/pluginRecord 字段），读写都保留 scopes，互不覆盖。 */
  private async loadTrustRecord(root: string, key: 'trustRecord' | 'pluginRecord' = 'trustRecord'): Promise<TrustRecord | undefined> {
    try {
      const t = await this.ctx.fs.resolve(this.baselinePath(root))
      const text = await this.ctx.fs.readText(t)
      if (text === null) return undefined
      const data = JSON.parse(text) as { trustRecord?: TrustRecord; pluginRecord?: TrustRecord }
      const rec = data?.[key]
      return rec !== undefined && typeof rec === 'object' ? rec : undefined
    } catch { return undefined }
  }

  private async saveTrustRecord(root: string, record: TrustRecord, key: 'trustRecord' | 'pluginRecord' = 'trustRecord'): Promise<void> {
    try {
      const t = await this.ctx.fs.resolve(this.baselinePath(root))
      let doc: Record<string, unknown> = {}
      try {
        const text = await this.ctx.fs.readText(t)
        if (text !== null) doc = JSON.parse(text) as Record<string, unknown>
      } catch { /* 无文件或损坏：从空文档开始 */ }
      await this.ctx.fs.writeText(t, JSON.stringify({ ...doc, version: 1, updatedAt: new Date().toISOString(), [key]: record }, null, 2) + '\n')
    } catch { /* 只读目录等场景静默跳过，不影响审计 */ }
  }

  /** 审计走势历史：基线同文件 history 字段，与 scopes/trustRecord/pluginRecord 互不覆盖。 */
  private async loadHistory(root: string): Promise<AuditHistoryEntry[]> {
    try {
      const t = await this.ctx.fs.resolve(this.baselinePath(root))
      const text = await this.ctx.fs.readText(t)
      if (text === null) return []
      const data = JSON.parse(text) as { history?: AuditHistoryEntry[] }
      return Array.isArray(data?.history) ? data.history : []
    } catch { return [] }
  }

  private async saveHistory(root: string, history: AuditHistoryEntry[]): Promise<void> {
    try {
      const t = await this.ctx.fs.resolve(this.baselinePath(root))
      let doc: Record<string, unknown> = {}
      try {
        const text = await this.ctx.fs.readText(t)
        if (text !== null) doc = JSON.parse(text) as Record<string, unknown>
      } catch { /* 无文件或损坏 */ }
      await this.ctx.fs.writeText(t, JSON.stringify({ ...doc, version: 1, updatedAt: new Date().toISOString(), history }, null, 2) + '\n')
    } catch { /* 只读目录静默跳过 */ }
  }

  /** 递归收集插件目录里的模型面文件（会被注入模型上下文的 SKILL.md/commands/agents 文本），限量防巨包。 */
  private async collectModelFacingFiles(dir: string, budget = 60): Promise<Array<{ rel: string; text: string }>> {
    const out: Array<{ rel: string; text: string }> = []
    const SKIP = new Set(['node_modules', '.git', 'dist', 'lib', 'build', 'coverage', '.worktrees', '.claude'])
    const walk = async (d: string, rel: string, depth: number): Promise<void> => {
      if (depth > 4 || out.length >= budget) return
      let entries: Array<{ name: string }> = []
      try { entries = await this.ctx.fs.listDir(await this.ctx.fs.resolve(d)) } catch { return }
      for (const e of entries) {
        if (out.length >= budget) return
        const name = e.name
        if (SKIP.has(name) || name.startsWith('.')) continue
        const child = `${d}/${name}`
        const childRel = rel === '' ? name : `${rel}/${name}`
        const text = await this.readTextFile(child)
        if (text !== null) {
          if (isModelFacingFile(childRel) && text.length <= 200_000) out.push({ rel: childRel, text })
          continue
        }
        await walk(child, childRel, depth + 1)
      }
    }
    await walk(dir, '', 0)
    return out
  }

  private async loadBaseline(root: string): Promise<Partial<Record<DepsecScope, string[]>>> {
    try {
      const t = await this.ctx.fs.resolve(this.baselinePath(root))
      const text = await this.ctx.fs.readText(t)
      if (text === null) return {}
      const data = JSON.parse(text) as { scopes?: Partial<Record<DepsecScope, string[]>> }
      return data && typeof data === 'object' && data.scopes && typeof data.scopes === 'object' ? data.scopes : {}
    } catch { return {} }
  }

  private async saveBaseline(root: string, scopes: Partial<Record<DepsecScope, string[]>>): Promise<void> {
    try {
      const t = await this.ctx.fs.resolve(this.baselinePath(root))
      await this.ctx.fs.writeText(t, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), scopes }, null, 2) + '\n')
    } catch { /* 只读目录等场景静默跳过，不影响审计 */ }
  }

  private async markNew(scope: DepsecScope, list: (DepsecFinding | DepsecVulnerability)[], root: string): Promise<number> {
    const all = await this.loadBaseline(root)
    const prev = new Set(all[scope] ?? [])
    const curr = new Set<string>()
    let n = 0
    for (const f of list) {
      const k = this.findingKey(scope, f)
      curr.add(k)
      f.isNew = !prev.has(k)
      if (f.isNew) n++
    }
    all[scope] = [...curr]
    await this.saveBaseline(root, all)
    return n
  }

  private async runSupplyChain(root: string): Promise<DepsecResult> {
    const det = await this.detectManager(root)
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(det.manager)) {
      return { ok: false, scope: 'supply-chain', root, manager: det.manager, verdict: 'clean', blockVerdict: 'pass', message: '供应链/投毒扫描当前支持 npm 系项目（需 package.json）' }
    }
    const pkg = await this.readJson(this.joinPath(root, 'package.json'))
    if (pkg === null) return { ok: false, scope: 'supply-chain', root, manager: det.manager, verdict: 'clean', blockVerdict: 'pass', message: '无法读取 package.json' }
    const depMap = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) }
    const depNames = Object.keys(depMap)
    const projScripts = this.scriptsOf(pkg)
    const nm = await this.scanNodeModules(root)
    // 动态近名宇宙：静态流行包榜单 + 该项目四处放行位置里的已信任包名（自己信任的不被自己的检测器误报）
    const trusted = new Set<string>([
      ...(((pkg.pnpm as Record<string, unknown> | undefined)?.onlyBuiltDependencies as string[] | undefined) ?? []),
      ...((pkg.trustedDependencies as string[] | undefined) ?? []),
      ...Object.entries((pkg.allowScripts as Record<string, unknown> | undefined) ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    ])
    const wsParse = parseAllowBuildsYaml(await this.readTextFile(this.joinPath(root, 'pnpm-workspace.yaml')) ?? undefined)
    if (wsParse.ok) for (const [k, v] of wsParse.entries) if (v === true) trusted.add(k)
    const typos = typosquatFindings(depNames, [...new Set([...TOP_PACKAGES, ...trusted])])
    const rep = await this.fetchReputation(depNames)

    let findings: DepsecFinding[] = []

    // 脚本内容审查：按证据分级（pass/warn/block），取代旧「带脚本一律 high」的全标红
    let scriptsPassed = 0
    let scriptsWarn = 0
    let scriptsBlocked = 0
    const pkgAllPass = new Map<string, boolean>()
    // 版本锁观测：包 → {版本, 脚本指纹, 最重判定}（deps only；root 是用户自己的项目）
    const observed: Record<string, { version: string; fingerprint: string; verdict: 'pass' | 'warn' | 'block'; scripts: string[] }> = {}
    const WORST = { pass: 0, warn: 1, block: 2 } as const
    const worstOf = (a: 'pass' | 'warn' | 'block' | undefined, b: 'pass' | 'warn' | 'block'): 'pass' | 'warn' | 'block' =>
      a !== undefined && WORST[a] > WORST[b] ? a : b
    const analyzeOne = async (name: string, dir: string, isRoot: boolean, s: { script: string; command: string }): Promise<DepsecFinding | null> => {
      const files: Record<string, string> = {}
      for (const ref of referencedScriptFiles(s.command)) {
        let text = await this.readTextFile(this.joinPath(dir, ref))
        if (text === null) text = await this.readTextFile(this.joinPath(dir, ref + '.js'))
        if (text !== null && text.length <= 65536) files[ref] = text
      }
      const a = analyzeInstallScript(s.command, files)
      if (!isRoot) {
        pkgAllPass.set(name, pkgAllPass.get(name) !== false && a.verdict === 'pass')
        const cur = observed[name]
        if (cur !== undefined) cur.verdict = worstOf(cur.verdict, a.verdict)
      }
      if (a.verdict === 'pass') {
        scriptsPassed++
        return null
      }
      if (a.verdict === 'warn') scriptsWarn++
      else scriptsBlocked++
      return {
        kind: isRoot ? '项目 install 脚本审查' : '依赖 install 脚本审查',
        name,
        detail: `${s.script}: ${s.command.slice(0, 160)}｜${renderSignals(a)}`,
        severity: a.verdict === 'block' ? 'high' : 'medium',
      }
    }
    const projName = (pkg.name as string) ?? '(root)'
    for (const s of projScripts) {
      const f = await analyzeOne(projName, root, true, s)
      if (f !== null) findings.push(f)
    }
    for (const dep of nm.findings) {
      const depPkg = await this.readJson(this.joinPath(dep.dir, 'package.json'))
      const version = typeof depPkg?.version === 'string' ? depPkg.version : ''
      observed[dep.name] = {
        version,
        fingerprint: scriptsFingerprint(dep.scripts),
        verdict: 'pass',
        scripts: dep.scripts.map((s) => s.script),
      }
      for (const s of dep.scripts) {
        const f = await analyzeOne(dep.name, dep.dir, false, s)
        if (f !== null) findings.push(f)
      }
    }

    // 版本锁：上次审计后升级/换脚本的依赖，原放行结论失效（coa/rc 式版本劫持路径）
    const prevRecord = await this.loadTrustRecord(root)
    for (const c of diffTrustRecord(prevRecord, observed)) {
      findings.push({
        kind: '依赖版本变更重审',
        name: c.name,
        detail: `${c.fromVersion} → ${c.toVersion}${c.scriptsChanged ? '，且 install 脚本已变化' : ''}：此前的审计/放行结论基于旧版本，需重新确认（版本劫持路径）`,
        severity: 'medium',
      })
    }
    findings.push(...typos)
    findings.push(...rep.items)

    // 放行清单候选：全部脚本 PASS 且无近名/信誉中高危的依赖
    const suspicious = new Set<string>()
    for (const t of typos) if (t.severity === 'high' || t.severity === 'medium') suspicious.add(t.name)
    for (const r of rep.items) if (r.severity === 'high' || r.severity === 'medium') suspicious.add(r.name)
    const approvals = [...pkgAllPass.entries()].filter(([name, pass]) => pass && !suspicious.has(name)).map(([name]) => name).sort()
    const ignores = await this.readIgnores(root)
    findings = this.applyIgnores(findings, ignores)
    const newCount = await this.markNew('supply-chain', findings, root)
    // 版本锁记录更新放最后：markNew 会整体重写基线文件，晚于它写才不会互相覆盖
    const trustChanges = diffTrustRecord(prevRecord, observed).length
    await this.saveTrustRecord(root, mergeTrustRecord(prevRecord, observed, new Date().toISOString()))
    const counts: Record<string, number> = { high: 0, medium: 0, low: 0, info: 0 }
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
    const summary: DepsecSummary = { total: findings.length, high: counts.high, medium: counts.medium, low: counts.low, info: counts.info, newCount }
    // 走势历史：写入基线 history（上限 30），并随结果回传给客户端画 sparkline
    const prevHistory = await this.loadHistory(root)
    const history = appendHistory(prevHistory, {
      at: new Date().toISOString(),
      high: counts.high, medium: counts.medium, low: counts.low, newCount,
    })
    await this.saveHistory(root, history)
    return {
      ok: true, scope: 'supply-chain', root, manager: det.manager, verdict: verdictOf(summary), blockVerdict: blockVerdictOf(summary),
      project: { name: (pkg.name as string) ?? '', version: (pkg.version as string) ?? '', depCount: depNames.length },
      summary, findings: findings.slice(0, 200),
      history,
      stats: {
        nodeModulesScanned: nm.scanned,
        reputationScanned: rep.items.length,
        reputationTruncated: rep.truncated ? 1 : 0,
        scriptsPassed,
        scriptsWarn,
        scriptsBlocked,
        approvalsSuggested: approvals.length,
      },
      note: [
        nm.skipped,
        rep.truncated ? '直接依赖超过 25 个，仅对前 25 个做联网信誉检查' : '',
        `install 脚本审查：${scriptsPassed} 通过 / ${scriptsWarn} 待查 / ${scriptsBlocked} 高危${approvals.length > 0 ? `；可放行 ${approvals.length} 个包（点「写回放行清单」）` : ''}`,
        trustChanges > 0 ? `${trustChanges} 个依赖自上次审计后升级/换脚本，原结论已失效（见「依赖版本变更重审」）` : '',
      ].filter(Boolean).join('；'),
    }
  }

  private async runVuln(root: string): Promise<DepsecResult> {
    let det
    try { det = await this.detectManager(root) } catch (e) { return { ok: false, detected: false, scope: 'vuln', manager: null, root, verdict: 'clean', blockVerdict: 'pass', error: e instanceof Error ? e.message : String(e) } }
    if (det.manager === 'unknown') return { ok: false, detected: false, scope: 'vuln', manager: null, root, verdict: 'clean', blockVerdict: 'pass', message: '未检测到受支持的包管理器清单' }
    const command = COMMANDS[det.manager]
    if (command === null || command === undefined) return { ok: false, detected: true, scope: 'vuln', manager: det.manager, root, verdict: 'clean', blockVerdict: 'pass', message: 'bun 暂无官方 audit 命令' }
    const run = await this.runCommand(command, root)
    const parsed = this.parseResult(det.manager, run.stdout)
    if (parsed === null) {
      const needle = run.stderr + ' ' + run.stdout
      const toolMissing = /not found|not recognized|无法识别|command not found|No such file|ENOENT/i.test(needle) || (run.exitCode !== 0 && run.stdout.trim().length === 0)
      return {
        ok: false, detected: true, scope: 'vuln', manager: det.manager, root, verdict: 'clean', blockVerdict: 'pass', command, exitCode: run.exitCode,
        error: toolMissing ? `审计工具未安装或不可用：请确认 \`${command.split(' ')[0]}\` 已安装并位于 PATH 中。` : `未能解析审计输出（退出码 ${run.exitCode}）。`,
        stderrTail: run.stderr.slice(0, 2000), stdoutTail: run.stdout.slice(0, 2000),
      }
    }
    const newCount = await this.markNew('vuln', parsed.list, root)
    const summary: DepsecSummary = { total: parsed.total, critical: parsed.critical, high: parsed.high, moderate: parsed.moderate, low: parsed.low, info: parsed.info, newCount }
    return { ok: true, detected: true, scope: 'vuln', manager: det.manager, root, verdict: verdictOf(summary), blockVerdict: blockVerdictOf(summary), command, exitCode: run.exitCode, timedOut: run.timedOut, summary, vulnerabilities: parsed.list, note: run.timedOut ? '审计超时（命令超过 120 秒被终止），结果可能不完整。' : '' }
  }

  private async runSecrets(root: string): Promise<DepsecResult> {
    const wt = await this.scanPatterns(root, SECRET_PATTERNS, '密钥', true)
    const hist = await this.scanGitHistory(root, SECRET_PATTERNS)
    const ignores = await this.readIgnores(root)
    let findings = this.applyIgnores([...wt.findings, ...hist.findings], ignores)
    const newCount = await this.markNew('secrets', findings, root)
    const counts: Record<string, number> = { high: 0, medium: 0, low: 0, info: 0 }
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
    const summary: DepsecSummary = { total: findings.length, high: counts.high, medium: counts.medium, low: counts.low, info: counts.info, newCount }
    return { ok: true, scope: 'secrets', root, verdict: verdictOf(summary), blockVerdict: blockVerdictOf(summary), summary, findings: findings.slice(0, 200), stats: { filesScanned: wt.scanned, historyCommits: hist.commits }, note: [wt.skipped, hist.note].filter(Boolean).join('；') }
  }

  private async runSast(root: string): Promise<DepsecResult> {
    const wt = await this.scanPatterns(root, SAST_PATTERNS, '代码', false)
    const ignores = await this.readIgnores(root)
    const findings = this.applyIgnores(wt.findings, ignores)
    const newCount = await this.markNew('sast', findings, root)
    const counts: Record<string, number> = { high: 0, medium: 0, low: 0, info: 0 }
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
    const summary: DepsecSummary = { total: findings.length, high: counts.high, medium: counts.medium, low: counts.low, info: counts.info, newCount }
    return { ok: true, scope: 'sast', root, verdict: verdictOf(summary), blockVerdict: blockVerdictOf(summary), summary, findings: findings.slice(0, 200), stats: { filesScanned: wt.scanned }, note: wt.skipped }
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
    // 仅 BLOCK 状态下弹通知；WARN/PASS 静默（避免噪声）。自动值守场景下，
    // 一次完整扫描可能在 pnpm install 之后才完成；通知只在"真的有高危"时出现。
    if (!r.ok) return
    if (r.blockVerdict !== 'block') return
    const s = r.summary
    const newTxt = s?.newCount ? `（新增 ${s.newCount}）` : ''
    await this.notifyWindows('依赖信任清单', `🔴 BLOCK：新装依赖里有 ${(s?.high ?? 0)} 个 install 脚本被高危阻断${newTxt}`)
  }

  private async notifyFor(r: DepsecResult): Promise<void> {
    const s = r.summary
    const newTxt = s?.newCount ? `（新增 ${s.newCount}）` : ''
    const label = r.scope === 'supply-chain' ? '信任清单扫描' : r.scope === 'secrets' ? '密钥扫描' : r.scope === 'sast' ? '代码扫描' : '漏洞审计'
    if (!r.ok) { await this.notifyWindows('依赖信任清单', `${label}未完成：${r.message ?? r.error ?? '未知错误'}`); return }
    // 手动触发的 runAudit 仍按 verdict 给完整通知；自动值守走 smartNotify
    const verdictTxt = r.blockVerdict === 'block' ? '🔴 BLOCK ' : r.blockVerdict === 'warn' ? '🟡 WARN ' : '🟢 PASS '
    await this.notifyWindows('依赖信任清单', `${verdictTxt}${label}：${s?.total ?? 0} 个${newTxt}`)
  }

  /**
   * 监听 bash/pwsh 工具结果后调扫描。延迟 30 秒，避免 pnpm install 还没装完就
   * 触发扫描（节点数错 + 误报），也避免 agent 装依赖的同一秒被扫描阻塞。
   * 节流 60 秒（连续多个 install 命令不重复扫）。
   */
  private autoScanTimer: ReturnType<typeof setTimeout> | null = null
  private async autoScanAfterInstall(agent: Agent | undefined): Promise<void> {
    const now = Date.now()
    if (now - this.lastAutoAt < 60000) {
      // 还在节流窗口内；不重置 lastAutoAt（避免被持续 install 命令延后到永远不触发）
      return
    }
    this.lastAutoAt = now
    if (this.autoScanTimer !== null) clearTimeout(this.autoScanTimer)
    const root = this.rootOfAgent(agent)
    if (root === undefined) return
    this.autoScanTimer = setTimeout(() => {
      void (async () => {
        const result = await this.runSupplyChain(root)
        this.monitoringState = { at: Date.now(), scope: 'supply-chain', verdict: result.verdict, blockVerdict: result.blockVerdict, total: result.summary?.total, high: result.summary?.high }
        await this.smartNotify(result)
      })()
    }, 30000)
  }

  private async runAudit(path: string | undefined, scope: DepsecScope): Promise<DepsecResult> {
    const root = this.rootFor(path)
    if (root === undefined) return { ok: false, detected: false, manager: null, verdict: 'clean', blockVerdict: 'pass', error: '无法确定工作区根目录（sandboxPolicy 服务不可用）' }
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
