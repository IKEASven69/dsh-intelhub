/**
 * trust-signals 纯函数层测试：近名检测的判级语义（dist1=high / dist2+长名=medium）、
 * exact 命中豁免、levenshtein 退化形态、slopsquatting 只认 404。
 */
import { describe, expect, it } from 'vitest'
import { levenshtein, nearestTyposquat, slopsquatFinding, typosquatFindings } from '../src/trust-signals.ts'

describe('levenshtein', () => {
  it('退化形态：空串', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
    expect(levenshtein('', '')).toBe(0)
  })
  it('经典距离', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('abc', 'abc')).toBe(0)
    expect(levenshtein('abc', 'axc')).toBe(1)
  })
})

describe('nearestTyposquat', () => {
  const universe = ['express', 'koa', 'lodash']

  it('exact 命中 → null（真包不是 typosquat）', () => {
    expect(nearestTyposquat('express', universe)).toBeNull()
  })
  it('取距离最近的候选', () => {
    expect(nearestTyposquat('expresss', universe)).toEqual({ best: 'express', dist: 1 })
  })
  it('全部太远 → null', () => {
    expect(nearestTyposquat('zzzz-yggdrasil', universe)).toBeNull()
  })
})

describe('typosquatFindings', () => {
  const universe = ['express', 'lodash']

  it('dist1 → high', () => {
    const f = typosquatFindings(['expresss'], universe)
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('high')
    expect(f[0]!.kind).toBe('疑似近名投毒')
    expect(f[0]!.detail).toContain('express')
  })
  it('dist2 且名长 ≥5 → medium', () => {
    const f = typosquatFindings(['expss'], universe)
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('medium')
  })
  it('dist2 但名长 <5 → 不报（避免短名误报）', () => {
    expect(typosquatFindings(['expr'], universe)).toHaveLength(0)
  })
  it('已信任/exact 名不报', () => {
    expect(typosquatFindings(['express', 'lodash'], universe)).toHaveLength(0)
  })
  it('项目自有信任名单并入宇宙后不再误报', () => {
    expect(typosquatFindings(['expresss'], [...universe, 'expresss'])).toHaveLength(0)
  })
})

describe('slopsquatFinding', () => {
  it('404 → high finding，语义点名 slopsquatting', () => {
    const f = slopsquatFinding('is-odd-pro', 404)
    expect(f).not.toBeNull()
    expect(f!.severity).toBe('high')
    expect(f!.kind).toBe('疑似 slopsquatting')
    expect(f!.detail).toContain('404')
  })
  it('200 / 网络失败（null）/ 其他状态码 → 不判定', () => {
    expect(slopsquatFinding('express', 200)).toBeNull()
    expect(slopsquatFinding('express', null)).toBeNull()
    expect(slopsquatFinding('express', 500)).toBeNull()
    expect(slopsquatFinding('express', 301)).toBeNull()
  })
})
