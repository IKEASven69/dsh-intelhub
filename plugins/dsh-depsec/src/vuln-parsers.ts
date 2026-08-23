/**
 * pip-audit / cargo audit / govulncheck 的 JSON 输出解析（纯函数，零宿主依赖）。
 * 返回形状与宿主侧 parseNpm 一致：total/critical/high/moderate/low/info + list。
 * npm 系（npm/pnpm/yarn）走 parseNpm 不经过这里。
 * 三者的「严重度」字段都可缺席：pip-audit 无严重度概念、rustsec/osv 常缺失——
 * 统一回退 moderate 并在 title 里保留原始标识，不做过度推断。
 * @module dsh-depsec/vuln-parsers
 */
import type { DepsecVulnerability } from './types.ts'

export interface VulnParseResult {
  total: number
  critical: number
  high: number
  moderate: number
  low: number
  info: number
  list: DepsecVulnerability[]
}

type Rec = Record<string, unknown>

function severityOf(s: unknown): string {
  const sev = String(s ?? '').toLowerCase()
  if (sev === 'critical' || sev === 'high' || sev === 'moderate' || sev === 'medium' || sev === 'low' || sev === 'info') {
    return sev === 'medium' ? 'moderate' : sev
  }
  return 'moderate'
}

function summarize(list: DepsecVulnerability[]): VulnParseResult {
  const counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } as Record<string, number>
  for (const v of list) counts[v.severity] = (counts[v.severity] ?? 0) + 1
  return {
    total: list.length,
    critical: counts.critical, high: counts.high, moderate: counts.moderate, low: counts.low, info: counts.info,
    list: list.slice(0, 100),
  }
}

/** pip-audit --format json：{dependencies:[{name,version,vulns:[{id,fix_versions,aliases}]}]} */
export function parsePipAudit(text: string): VulnParseResult | null {
  let data: Rec
  try { data = JSON.parse(text) as Rec } catch { return null }
  const deps = data.dependencies
  if (!Array.isArray(deps)) return null
  const list: DepsecVulnerability[] = []
  for (const d0 of deps) {
    if (d0 === null || typeof d0 !== 'object') continue
    const d = d0 as Rec
    const vulns = Array.isArray(d.vulns) ? d.vulns : []
    for (const v0 of vulns) {
      if (v0 === null || typeof v0 !== 'object') continue
      const v = v0 as Rec
      const id = String(v.id ?? '')
      if (id === '') continue
      const aliases = Array.isArray(v.aliases) ? v.aliases.map(String) : []
      const fixes = Array.isArray(v.fix_versions) ? v.fix_versions.map(String) : []
      list.push({
        name: `${String(d.name ?? '?')}@${String(d.version ?? '?')}`,
        severity: 'moderate',
        range: String(d.version ?? ''),
        title: [id, ...aliases].join(' / '),
        url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
        fixAvailable: fixes.length > 0,
      })
    }
  }
  return summarize(list)
}

/** cargo audit --json：{vulnerabilities:{count,vulns:[{advisory:{id,package,title,url,severity,versions:{patched}},versions:{fixed}}]}} */
export function parseCargoAudit(text: string): VulnParseResult | null {
  let data: Rec
  try { data = JSON.parse(text) as Rec } catch { return null }
  const vs = data.vulnerabilities
  if (vs === null || typeof vs !== 'object') return null
  const vulns = (vs as Rec).vulns
  if (!Array.isArray(vulns)) return null
  const list: DepsecVulnerability[] = []
  for (const v0 of vulns) {
    if (v0 === null || typeof v0 !== 'object') continue
    const v = v0 as Rec
    const adv = (v.advisory ?? null) as Rec | null
    if (adv === null) continue
    const id = String(adv.id ?? '')
    if (id === '') continue
    const patched = adv.versions && typeof adv.versions === 'object'
      ? (adv.versions as Rec).patched : v.versions && typeof v.versions === 'object' ? (v.versions as Rec).fixed : null
    const patchedArr = Array.isArray(patched) ? patched.map(String) : []
    list.push({
      name: String(adv.package ?? '?'),
      severity: severityOf(adv.severity),
      range: String(adv.affected ?? ''),
      title: String(adv.title ?? id),
      url: String(adv.url ?? `https://rustsec.org/advisories/${id}`),
      fixAvailable: patchedArr.length > 0,
    })
  }
  return summarize(list)
}

/**
 * govulncheck -json：NDJSON 流（config/progress/osv/finding 各一行一个对象）。
 * 只统计有 trace 的 finding（调用图确认可达），按 (osv id, module) 去重；
 * 修复判定取 trace 任一 frame 带 fixed 版本。
 */
export function parseGoVulncheck(text: string): VulnParseResult | null {
  const osv = new Map<string, { title: string; severity: string; aliases: string[] }>()
  const seen = new Map<string, DepsecVulnerability>()
  let sawFinding = false
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (s === '') continue
    let obj: Rec
    try { obj = JSON.parse(s) as Rec } catch { continue }
    if (obj.osv !== null && typeof obj.osv === 'object') {
      const o = obj.osv as Rec
      const id = String(o.id ?? '')
      if (id === '') continue
      const dbSpec = (o.database_specific ?? null) as Rec | null
      const aliases = Array.isArray(o.aliases) ? o.aliases.map(String) : []
      osv.set(id, {
        title: String(o.summary ?? id).slice(0, 120),
        severity: severityOf(dbSpec && dbSpec.severity !== undefined ? dbSpec.severity : ''),
        aliases,
      })
    } else if (obj.finding !== null && typeof obj.finding === 'object') {
      const f = obj.finding as Rec
      if (typeof f.osv !== 'string' || !Array.isArray(f.trace) || f.trace.length === 0) continue
      sawFinding = true
      const mod = (f.trace[f.trace.length - 1] as Rec)?.module ?? (f.trace[0] as Rec)?.module ?? '?'
      const key = f.osv + '|' + String(mod)
      if (seen.has(key)) continue
      let fixAvailable = false
      for (const fr0 of f.trace) {
        const fr = fr0 as Rec
        if (fr.fixed !== undefined && fr.fixed !== null) { fixAvailable = true; break }
      }
      const meta = osv.get(f.osv)
      seen.set(key, {
        name: String(mod),
        severity: meta ? meta.severity : 'moderate',
        range: String(f.fixed_version ?? ''),
        title: [f.osv, ...(meta ? meta.aliases.slice(0, 1) : [])].join(' / '),
        url: `https://pkg.go.dev/vuln/${f.osv}`,
        fixAvailable,
      })
    }
  }
  if (!sawFinding && osv.size === 0) return null
  return summarize([...seen.values()])
}
