/**
 * 放行清单写回测试：pnpm 11 allowBuilds（pnpm-workspace.yaml）与 npm 12 allowScripts（package.json）。
 * 纪律：显式拒绝（false）永不被翻转；非我方块/键的内容原样保留；形态未知时拒绝写入。
 */
import { describe, expect, it } from 'vitest'
import { mergeAllowBuildsYaml, mergeAllowScriptsDoc, parseAllowBuildsYaml } from '../src/trust-writeback.ts'

const WS = 'packages:\n  - "plugins/*"\n\nonlyBuiltDependencies:\n  - esbuild\n'

describe('parseAllowBuildsYaml', () => {
  it('空/缺文件 → 空表', () => {
    expect(parseAllowBuildsYaml(undefined).entries.size).toBe(0)
    expect(parseAllowBuildsYaml('').entries.size).toBe(0)
  })

  it('读出 true/false 条目', () => {
    const p = parseAllowBuildsYaml('allowBuilds:\n  "esbuild": true\n  "bad": false\n')
    expect(p.ok).toBe(true)
    expect(p.entries.get('esbuild')).toBe(true)
    expect(p.entries.get('bad')).toBe(false)
  })

  it('作用域包名的带引号键可解析', () => {
    const p = parseAllowBuildsYaml('allowBuilds:\n  "@openclaw/fs-safe": true\n')
    expect(p.ok).toBe(true)
    expect(p.entries.get('@openclaw/fs-safe')).toBe(true)
  })

  it('下一个顶层键处停止', () => {
    const p = parseAllowBuildsYaml('allowBuilds:\n  "a": true\npackages:\n  - x\n')
    expect(p.ok).toBe(true)
    expect(p.entries.size).toBe(1)
  })

  it('块内形态未知 → 拒绝解析', () => {
    const p = parseAllowBuildsYaml('allowBuilds:\n  foo: bar\n')
    expect(p.ok).toBe(false)
  })
})

describe('mergeAllowBuildsYaml', () => {
  it('缺文件 → 创建只含 allowBuilds 的新文件', () => {
    const w = mergeAllowBuildsYaml(undefined, ['esbuild'])
    expect(w.ok).toBe(true)
    expect(w.text).toBe('allowBuilds:\n  "esbuild": true\n')
    expect(w.added).toEqual(['esbuild'])
  })

  it('已有文件 → 其余内容原样保留，块追加在末尾', () => {
    const w = mergeAllowBuildsYaml(WS, ['esbuild'])
    expect(w.ok).toBe(true)
    expect(w.text).toContain('packages:')
    expect(w.text).toContain('onlyBuiltDependencies:')
    expect(w.text).toContain('"esbuild": true')
    expect(w.added).toEqual(['esbuild'])
  })

  it('已有块 → 合并去重，true 保留', () => {
    const w = mergeAllowBuildsYaml('allowBuilds:\n  "esbuild": true\n', ['esbuild', 'sharp'])
    expect(w.added).toEqual(['sharp'])
    expect(w.text).toContain('"esbuild": true')
    expect(w.text).toContain('"sharp": true')
  })

  it('显式 false 不翻转、记入 skippedDenied', () => {
    const w = mergeAllowBuildsYaml('allowBuilds:\n  "bad": false\n', ['bad'])
    expect(w.ok).toBe(true)
    expect(w.skippedDenied).toEqual(['bad'])
    expect(w.text).toContain('"bad": false')
    expect(w.added).toEqual([])
  })

  it('块形态未知 → 合并放弃（ok:false），不产出文本', () => {
    const w = mergeAllowBuildsYaml('allowBuilds:\n  foo: bar\n', ['esbuild'])
    expect(w.ok).toBe(false)
    expect(w.error).toContain('形态')
    expect(w.text).toBeUndefined()
  })

  it('多包写入按 Ordinal 排序（双向比较都有序）', () => {
    const w = mergeAllowBuildsYaml(undefined, ['zod', 'abc', 'mch'])
    expect(w.ok).toBe(true)
    const i1 = w.text!.indexOf('"abc"')
    const i2 = w.text!.indexOf('"mch"')
    const i3 = w.text!.indexOf('"zod"')
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
  })

  it('原文末行非空 → 先补空行再追加块', () => {
    const w = mergeAllowBuildsYaml('packages:\n  - "x"', ['esbuild'])
    expect(w.text).toBe('packages:\n  - "x"\n\nallowBuilds:\n  "esbuild": true\n')
  })

  it('pnpm 11 占位提示行视为「未设置」，可被安全写入真实决定', () => {
    const w = mergeAllowBuildsYaml(
      "allowBuilds:\n  '@swc/core': set this to true or false\n  esbuild: set this to true or false\n",
      ['@swc/core', 'esbuild'],
    )
    expect(w.ok).toBe(true)
    expect(w.added).toEqual(['@swc/core', 'esbuild'])
    expect(w.text).toBe('allowBuilds:\n  "@swc/core": true\n  "esbuild": true\n')
  })
})

describe('mergeAllowScriptsDoc', () => {
  it('npm 12 allowScripts：新增 true，其余键原样保留', () => {
    const w = mergeAllowScriptsDoc({ name: 'x', version: '1.0.0' }, ['esbuild'])
    expect((w.doc.allowScripts as Record<string, unknown>).esbuild).toBe(true)
    expect(w.doc.name).toBe('x')
    expect(w.added).toEqual(['esbuild'])
  })

  it('显式 false 不翻转', () => {
    const w = mergeAllowScriptsDoc({ allowScripts: { bad: false } }, ['bad'])
    expect(w.skippedDenied).toEqual(['bad'])
    expect((w.doc.allowScripts as Record<string, unknown>).bad).toBe(false)
  })
})
