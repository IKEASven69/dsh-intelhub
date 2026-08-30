/**
 * 依赖安全审计插件共享类型：全部为可跨 RPC 的无损 JSON。
 * @module dsh-depsec/types
 */

/** 审计范围。 */
export type DepsecScope = 'vuln' | 'supply-chain' | 'secrets' | 'sast'

/** 判定：干净 / 有告警 / 有高危。 */
export type DepsecVerdict = 'clean' | 'warning' | 'critical'

/**
 * 三档闸门语义，与 dsh-market / dsh-plugin-gate 对齐。
 * 与 {@link DepsecVerdict} 并行：旧字段保留以兼容既有基线与 UI 文本；
 * 新 UI 与 SARIF 输出优先消费 `blockVerdict`。
 */
export type BlockVerdict = 'pass' | 'warn' | 'block'

/** 一条文件级发现（密钥 / SAST / 投毒）。 */
export interface DepsecFinding {
  kind?: string
  name: string
  file?: string
  line?: number
  commit?: string
  detail?: string
  severity: string
  isNew?: boolean
}

/** 一条依赖漏洞。 */
export interface DepsecVulnerability {
  name: string
  severity: string
  range?: string
  title?: string
  url?: string
  direct?: boolean
  fixAvailable?: boolean
  isNew?: boolean
}

/** 严重度汇总。 */
export interface DepsecSummary {
  total: number
  critical?: number
  high?: number
  moderate?: number
  medium?: number
  low?: number
  info?: number
  newCount?: number
}

/** 一次审计结果（host 返回给 client / 模型）。 */
export interface DepsecResult {
  ok: boolean
  scope?: DepsecScope
  root?: string
  manager?: string | null
  verdict?: DepsecVerdict
  /**
   * 三档闸门语义：与 verdict 并行；新 UI 与 SARIF 优先消费此字段。
   * - pass：无高/中危信号
   * - warn：有中危或低危，需要人工看
   * - block：有高危或 install 脚本被 block，**不能放行**
   */
  blockVerdict?: BlockVerdict
  summary?: DepsecSummary
  vulnerabilities?: DepsecVulnerability[]
  findings?: DepsecFinding[]
  /** supply-chain：脚本全 PASS 且无其他中高危信号、可写回放行清单的依赖名。 */
  approvals?: string[]
  project?: { name: string; version?: string; depCount: number }
  stats?: Record<string, number>
  command?: string
  exitCode?: number | null
  error?: string
  message?: string
  note?: string
  stderrTail?: string
  stdoutTail?: string
}

/** audit RPC 请求。 */
export interface AuditRequest {
  path?: string
  scope?: DepsecScope
}

/** audit-fix RPC 请求。 */
export interface FixRequest {
  path?: string
}

/** fix 结果。 */
export interface FixResult {
  ok: boolean
  command?: string
  error?: string
  stdoutTail?: string
}

/** SARIF 导出结果。 */
export interface SarifResult {
  ok: boolean
  path?: string
  ruleCount?: number
  resultCount?: number
  error?: string
}

/** open-file RPC 请求。 */
export interface OpenFileRequest {
  path: string
  line?: number
}

/** write-approvals RPC 请求。 */
export interface WriteApprovalsRequest {
  path?: string
  /** 指定包名列表；缺省时重新扫描，取「全部脚本 PASS 且无近名/信誉中高危」的依赖。 */
  packages?: string[]
  /** 只计算不写回。 */
  dryRun?: boolean
}

/** write-approvals 结果。 */
export interface WriteApprovalsResult {
  ok: boolean
  added?: string[]
  existing?: string[]
  total?: number
  /** 显式拒绝（allowScripts / allowBuilds 为 false）而未被自动放行的包。 */
  denied?: string[]
  /** 本次写入（或 dryRun 将写入）的落点描述。 */
  targets?: string[]
  error?: string
  note?: string
}

/** 监控状态。 */
export interface MonitorState {
  at?: number
  scope?: DepsecScope
  verdict?: DepsecVerdict
  blockVerdict?: BlockVerdict
  total?: number
  high?: number
}

/** 已安装插件审查：单个插件的逐维度 verdict。 */
export interface PluginRosterEntry {
  name: string
  version: string
  dir: string
  manager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'link' | 'file' | 'git' | 'unknown'
  /** 每个维度单独给一档闸门：pass / warn / block；未跑的维度为 'pass' 表示"未发现问题"。 */
  verdicts: {
    supplyChain: BlockVerdict
    secrets: BlockVerdict
    sast: BlockVerdict
  }
  findings: DepsecFinding[]
  note?: string
  error?: string
}

/** scan-installed-plugins RPC 结果。 */
export interface PluginRosterResult {
  ok: boolean
  scope: 'plugin-roster'
  profile: string
  total: number
  /** 按聚合 verdict（block > warn > pass）排序的插件列表。 */
  plugins: PluginRosterEntry[]
  error?: string
  note?: string
}
