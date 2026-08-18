/**
 * 依赖安全审计插件共享类型：全部为可跨 RPC 的无损 JSON。
 * @module dsh-depsec/types
 */

/** 审计范围。 */
export type DepsecScope = 'vuln' | 'supply-chain' | 'secrets' | 'sast'

/** 判定：干净 / 有告警 / 有高危。 */
export type DepsecVerdict = 'clean' | 'warning' | 'critical'

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
  summary?: DepsecSummary
  vulnerabilities?: DepsecVulnerability[]
  findings?: DepsecFinding[]
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

/** 监控状态。 */
export interface MonitorState {
  at?: number
  scope?: DepsecScope
  verdict?: DepsecVerdict
  total?: number
  high?: number
}
