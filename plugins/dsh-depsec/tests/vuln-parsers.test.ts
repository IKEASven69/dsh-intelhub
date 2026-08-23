/**
 * 三语言审计器输出解析的回归语料：pip-audit / cargo audit / govulncheck。
 * 样本取自各工具公开 JSON schema 的典型形态（含字段缺席的退化情况）。
 */
import { describe, expect, it } from 'vitest'
import { parseCargoAudit, parseGoVulncheck, parsePipAudit } from '../src/vuln-parsers.ts'

const PIP_SAMPLE = JSON.stringify({
  dependencies: [
    {
      name: 'requests', version: '2.19.0',
      vulns: [
        { id: 'PYSEC-2018-18074', fix_versions: ['2.20.0'], aliases: ['CVE-2018-18074', 'GHSA-x84v-xcm2-4pgm'] },
        { id: 'PYSEC-2018-191', fix_versions: [] },
      ],
    },
    { name: 'flask', version: '3.0.0', vulns: [] },
  ],
  metadata: { dependencies: 2, vulnerabilities: 2 },
})

const CARGO_SAMPLE = JSON.stringify({
  database: { advisoryCount: 701 },
  vulnerabilities: {
    count: 2,
    vulns: [
      {
        advisory: {
          id: 'RUSTSEC-2022-0013', package: 'threadpool', title: 'Threadpool data race',
          url: 'https://rustsec.org/advisories/RUSTSEC-2022-0013', severity: 'critical',
          versions: { patched: ['>=1.8.0'] },
        },
        versions: { affected: '<1.8.0', fixed: ['1.8.0'] },
      },
      {
        advisory: {
          id: 'RUSTSEC-2021-0145', package: 'regex', title: 'Regex DoS',
          versions: { patched: ['>=1.5.5'] },
        },
      },
    ],
  },
})

const GO_SAMPLE = [
  JSON.stringify({ config: { protocol_version: 'v1.1.0' } }),
  JSON.stringify({ progress: { message: 'Scanning your code and P packages across M dependent modules for known vulnerabilities...' } }),
  JSON.stringify({
    osv: {
      id: 'GO-2024-2599', summary: 'Denial of service due to improper 100-continue handling',
      aliases: ['CVE-2024-24787'],
      database_specific: { severity: 'HIGH', url: 'https://pkg.go.dev/vuln/GO-2024-2599' },
    },
  }),
  JSON.stringify({
    finding: {
      osv: 'GO-2024-2599', fixed_version: '1.22.2',
      trace: [
        { module: 'stdlib', version: 'go1.21.0' },
        { module: 'golang.org/x/net', fixed: 'v0.23.0' },
      ],
    },
  }),
  JSON.stringify({
    finding: {
      osv: 'GO-2024-2599',
      trace: [{ module: 'golang.org/x/net', fixed: 'v0.23.0' }],
    },
  }),
  // 同一 OSV 不同模块应各计一条
  JSON.stringify({
    finding: { osv: 'GO-2024-2599', trace: [{ module: 'example.com/other' }] },
  }),
].join('\n')

describe('parsePipAudit', () => {
  it('把依赖×漏洞展平，fix_versions 决定可修复', () => {
    const r = parsePipAudit(PIP_SAMPLE)!
    expect(r.total).toBe(2)
    expect(r.moderate).toBe(2)
    const first = r.list.find((v) => v.name === 'requests@2.19.0' && v.title.includes('18074'))!
    expect(first.fixAvailable).toBe(true)
    expect(first.url).toContain('osv.dev/vulnerability/PYSEC-2018-18074')
    const second = r.list.find((v) => v.title.startsWith('PYSEC-2018-191'))!
    expect(second.fixAvailable).toBe(false)
  })
  it('非 JSON 返回 null', () => {
    expect(parsePipAudit('panic: not json')).toBeNull()
  })
})

describe('parseCargoAudit', () => {
  it('读 advisory severity 与 patched；severity 缺席回退 moderate', () => {
    const r = parseCargoAudit(CARGO_SAMPLE)!
    expect(r.total).toBe(2)
    expect(r.critical).toBe(1)
    const regex = r.list.find((v) => v.name === 'regex')!
    expect(regex.severity).toBe('moderate')
    expect(regex.fixAvailable).toBe(true)
    expect(regex.url).toContain('rustsec.org')
  })
  it('缺 vulnerabilities 键返回 null', () => {
    expect(parseCargoAudit('{"database":{}}')).toBeNull()
  })
})

describe('parseGoVulncheck', () => {
  it('NDJSON 流：osv 元数据 + finding 展开为 (osv,漏洞所在模块) 条目并去重', () => {
    const r = parseGoVulncheck(GO_SAMPLE)!
    expect(r.total).toBe(2) // x/net 与 example.com/other 两个模块；重复的 x/net 条被去重
    expect(r.high).toBe(2)
    const xnet = r.list.find((v) => v.name === 'golang.org/x/net')!
    expect(xnet.fixAvailable).toBe(true)
    expect(xnet.title).toContain('CVE-2024-24787')
    expect(r.list.find((v) => v.name === 'example.com/other')!.fixAvailable).toBe(false)
  })
  it('没有 osv 也没有 finding（比如纯 progress）返回 null', () => {
    expect(parseGoVulncheck(JSON.stringify({ progress: { message: '...' } }))).toBeNull()
  })
})
