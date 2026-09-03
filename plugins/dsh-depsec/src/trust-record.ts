/**
 * 版本锁记录的纯函数层：防「包名级放行 + 版本劫持换脚本」绕过（coa/rc 事件的攻击路径）。
 * 语义：审计时记录「包 → {版本, install 脚本指纹, 结论}」；下次审计发现版本或指纹变了，
 * 之前的放行/审计结论即失效，产出「需重审」发现。存储挂在本插件的 .depsec-baseline.json 里。
 * @module dsh-depsec/trust-record
 */

export interface TrustRecordEntry {
  version: string
  /** install 生命周期脚本的 FNV-1a 指纹（对脚本名+命令排序后哈希） */
  fingerprint: string
  verdict: 'pass' | 'warn' | 'block'
  scripts: string[]
  at: string
}

export type TrustRecord = Record<string, TrustRecordEntry>

/** 32 位 FNV-1a，输出 8 位十六进制。选择它不是为密码学强度，是为稳定、快、零依赖。 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 文件内容指纹（插件哈希锁用）：对「路径\0内容\0」排序后 FNV-1a——路径或内容任一变化即变化。 */
export function filesFingerprint(files: { path: string; content: string }[]): string {
  const joined = files
    .map((f) => `${f.path}\0${f.content}\0`)
    .sort()
    .join('')
  return fnv1a(joined)
}

/** 脚本指纹：对「脚本名\0命令\0」条目按字典序排序后哈希——顺序无关，只对内容敏感。 */
export function scriptsFingerprint(scripts: { script: string; command: string }[]): string {
  const joined = scripts
    .map((s) => `${s.script}\u0000${s.command}\u0000`)
    .sort()
    .join('')
  return fnv1a(joined)
}

export interface TrustRecordChange {
  name: string
  fromVersion: string
  toVersion: string
  scriptsChanged: boolean
}

/** 对比上次记录与本次观测，找出「版本变了或脚本指纹变了」的包（新增的包不算变更——它们本来就要走完整审计）。 */
export function diffTrustRecord(
  prev: TrustRecord | undefined,
  current: Record<string, { version: string; fingerprint: string }>,
): TrustRecordChange[] {
  if (prev === undefined) return []
  const out: TrustRecordChange[] = []
  for (const [name, cur] of Object.entries(current)) {
    const p = prev[name]
    if (p === undefined) continue
    if (p.version !== cur.version || p.fingerprint !== cur.fingerprint) {
      out.push({ name, fromVersion: p.version, toVersion: cur.version, scriptsChanged: p.fingerprint !== cur.fingerprint })
    }
  }
  return out
}

/** 用本次观测更新记录（保留 at 时间戳为本次审计时刻；调用方负责读写宿主文件）。 */
export function mergeTrustRecord(
  prev: TrustRecord | undefined,
  observed: Record<string, { version: string; fingerprint: string; verdict: 'pass' | 'warn' | 'block'; scripts: string[] }>,
  at: string,
): TrustRecord {
  const out: TrustRecord = { ...(prev ?? {}) }
  for (const [name, o] of Object.entries(observed)) {
    out[name] = { version: o.version, fingerprint: o.fingerprint, verdict: o.verdict, scripts: o.scripts, at }
  }
  // 已不在依赖树里的条目清掉，记录不无限膨胀
  for (const k of Object.keys(out)) if (!(k in observed)) delete out[k]
  return out
}
