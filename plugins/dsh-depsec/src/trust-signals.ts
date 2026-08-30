/**
 * 信任信号纯函数层：typosquatting 近名检测（候选宇宙可动态注入）与 slopsquatting 判定。
 * 宿主只负责取数——registry 状态码、项目自有信任名单；判定全部在此，可 100% 单测。
 * @module dsh-depsec/trust-signals
 */
import type { DepsecFinding } from './types.ts'

export function levenshtein(a: string, b: string): number {
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

export interface NearMatch {
  best: string
  dist: number
}

/** 在候选宇宙里找与 name 最近的近名（dist ≤ 2）；name 本身在宇宙中（exact）返回 null——那是真包，不是 typosquat。 */
export function nearestTyposquat(name: string, universe: readonly string[]): NearMatch | null {
  let best: string | null = null
  let bestDist = 3
  for (const top of universe) {
    if (top === name) return null
    const d = levenshtein(name, top)
    if (d < bestDist) {
      bestDist = d
      best = top
    }
  }
  return best === null ? null : { best, dist: bestDist }
}

/**
 * 近名投毒 findings：dist 1 → high；dist 2 且名长 ≥5 → medium。
 * 宇宙由宿主动态注入：静态流行包榜单 + 该项目四处放行位置里的已信任包名——
 * 项目自己信任的包不会被自己的检测器误报。
 */
export function typosquatFindings(names: string[], universe: readonly string[]): DepsecFinding[] {
  const out: DepsecFinding[] = []
  for (const name of names) {
    const m = nearestTyposquat(name, universe)
    if (m === null) continue
    if (m.dist === 1) {
      out.push({ kind: '疑似近名投毒', name, detail: `与流行包 \`${m.best}\` 仅差 1 字符`, severity: 'high' })
    } else if (m.dist === 2 && name.length >= 5) {
      out.push({ kind: '疑似近名投毒', name, detail: `与流行包 \`${m.best}\` 仅差 2 字符`, severity: 'medium' })
    }
  }
  return out
}

/**
 * slopsquatting：registry 返回 404 = 该包名不存在——agent 幻觉包名被抢注（或手滑拼错）的最危险安装形态。
 * 只有 404 判定；其他非 2xx 属于网络/服务问题，由宿主的「registry 不可达」处理。
 */
export function slopsquatFinding(name: string, statusCode: number | null): DepsecFinding | null {
  if (statusCode !== 404) return null
  return {
    kind: '疑似 slopsquatting',
    name,
    detail: 'registry 上不存在此包名（404）——agent 幻觉包名被抢注或拼写错误的高危形态',
    severity: 'high',
  }
}
