/**
 * 版本锁记录测试：指纹稳定性 + 变更检测语义（防 coa/rc 式版本劫持绕过包名级放行）。
 */
import { describe, expect, it } from 'vitest'
import { diffTrustRecord, mergeTrustRecord, scriptsFingerprint } from '../src/trust-record.ts'

describe('scriptsFingerprint', () => {
  it('同样内容稳定，脚本条目顺序无关', () => {
    const a = [
      { script: 'postinstall', command: 'node install.js' },
      { script: 'preinstall', command: 'echo hi' },
    ]
    const b = [
      { script: 'preinstall', command: 'echo hi' },
      { script: 'postinstall', command: 'node install.js' },
    ]
    expect(scriptsFingerprint(a)).toBe(scriptsFingerprint(b))
    expect(scriptsFingerprint(a)).toMatch(/^[0-9a-f]{8}$/)
  })
  it('命令或脚本名变化 → 指纹变化', () => {
    const base = [{ script: 'postinstall', command: 'node install.js' }]
    expect(scriptsFingerprint(base)).not.toBe(scriptsFingerprint([{ script: 'postinstall', command: 'node install.js && curl evil' }]))
    expect(scriptsFingerprint(base)).not.toBe(scriptsFingerprint([{ script: 'preinstall', command: 'node install.js' }]))
  })
})

describe('diffTrustRecord', () => {
  const prev = {
    esbuild: { version: '0.25.0', fingerprint: 'aaaa1111', verdict: 'pass', scripts: ['postinstall'], at: '2026-08-01T00:00:00Z' },
    sharp: { version: '0.33.0', fingerprint: 'bbbb2222', verdict: 'pass', scripts: ['install'], at: '2026-08-01T00:00:00Z' },
    husky: { version: '9.0.0', fingerprint: 'cccc3333', verdict: 'pass', scripts: ['postinstall'], at: '2026-08-01T00:00:00Z' },
  }
  it('版本变了 → 变更（scriptsChanged=false）', () => {
    const cur = { esbuild: { version: '0.26.0', fingerprint: 'aaaa1111' } }
    const d = diffTrustRecord(prev, cur)
    expect(d).toEqual([{ name: 'esbuild', fromVersion: '0.25.0', toVersion: '0.26.0', scriptsChanged: false }])
  })
  it('同版本但脚本指纹变了 → 变更（版本劫持核心场景）', () => {
    const cur = { sharp: { version: '0.33.0', fingerprint: 'deadbeef' } }
    const d = diffTrustRecord(prev, cur)
    expect(d).toEqual([{ name: 'sharp', fromVersion: '0.33.0', toVersion: '0.33.0', scriptsChanged: true }])
  })
  it('完全没变 → 无变更；新增依赖不算变更', () => {
    expect(diffTrustRecord(prev, {
      esbuild: { version: '0.25.0', fingerprint: 'aaaa1111' },
      sharp: { version: '0.33.0', fingerprint: 'bbbb2222' },
      husky: { version: '9.0.0', fingerprint: 'cccc3333' },
      'brand-new-dep': { version: '1.0.0', fingerprint: '00000000' },
    })).toEqual([])
  })
  it('prev 为空（首次审计）→ 无变更', () => {
    expect(diffTrustRecord(undefined, { esbuild: { version: '0.25.0', fingerprint: 'aaaa1111' } })).toEqual([])
  })
})

describe('mergeTrustRecord', () => {
  it('更新观测到的包、清除已卸载的包', () => {
    const prev = {
      old: { version: '1.0.0', fingerprint: 'aaaa1111', verdict: 'pass', scripts: [], at: '2026-01-01T00:00:00Z' },
      keep: { version: '2.0.0', fingerprint: 'bbbb2222', verdict: 'pass', scripts: ['postinstall'], at: '2026-01-01T00:00:00Z' },
    }
    const next = mergeTrustRecord(prev, {
      keep: { version: '2.1.0', fingerprint: 'bbbb2222', verdict: 'warn', scripts: ['postinstall'] },
    }, '2026-09-01T00:00:00Z')
    expect(Object.keys(next).sort()).toEqual(['keep'])
    expect(next.keep!.version).toBe('2.1.0')
    expect(next.keep!.verdict).toBe('warn')
    expect(next.keep!.at).toBe('2026-09-01T00:00:00Z')
  })
})

import { appendHistory, HISTORY_CAP } from '../src/trust-record.ts'

describe('appendHistory', () => {
  const e = (high: number): { at: string; high: number; medium: number; low: number; newCount: number } =>
    ({ at: '2026-09-01T00:00:00Z', high, medium: 0, low: 0, newCount: 0 })
  it('追加到尾部；超上限裁掉最旧', () => {
    let h = appendHistory(undefined, e(0))
    expect(h).toHaveLength(1)
    for (let i = 0; i < HISTORY_CAP + 5; i++) h = appendHistory(h, e(i))
    expect(h).toHaveLength(HISTORY_CAP)
    expect(h![h!.length - 1]!.high).toBe(HISTORY_CAP + 4)
  })
  it('不修改入参（纯函数）', () => {
    const prev = [e(1)]
    appendHistory(prev, e(2))
    expect(prev).toHaveLength(1)
  })
})
