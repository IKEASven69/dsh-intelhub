/**
 * install 生命周期脚本内容静态分析：把「带脚本=高危」改成证据分级（pass/warn/block）。
 * 纯函数、零宿主依赖；宿主侧负责读取脚本引用的本地 .js 文件后传入 files。
 * @module dsh-depsec/script-analysis
 */

export type ScriptVerdict = 'pass' | 'warn' | 'block'

export interface ScriptSignal {
  level: 'red' | 'yellow' | 'green'
  text: string
}

export interface ScriptAnalysis {
  verdict: ScriptVerdict
  signals: ScriptSignal[]
  subCommands: string[]
  /** 实际读到的脚本引用文件（host 传入的 key）。 */
  filesRead: string[]
  /** 命令引用但 host 未能提供的文件。 */
  filesMissing: string[]
}

/** install 脚本里常见、可放心的下载域名（预编译二进制等的官方分发处）。 */
const KNOWN_DOWNLOAD_HOSTS = new Set([
  'github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
  'nodejs.org', 'nodejs.com', 'registry.npmjs.org', 'npmjs.org', 'www.npmjs.org',
  'yarnpkg.com', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
  'crates.io', 'static.crates.io', 'golang.org', 'storage.googleapis.com',
  'dl.google.com', 'azureedge.net', 'npmcdn.com', 'unpkg.com',
  'snapcraft.io', 'api.snapcraft.io',
])

/** 敏感路径：install 脚本无论读还是传都视为红线。
 * .env 用负向后行断言排除 process.env / import.meta.env 等属性访问(E2E 实测 esbuild 误报)。 */
const SENSITIVE_PATH_RE =
  /(\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc|\.gnupg|\/etc\/passwd|cookies\.sqlite|MetaMask|metamask|wallet\.dat|(?<![\w])\.env\b)/i

const FETCHER_RE = /\b(curl|wget|fetch|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i
const INTERPRETER_AFTER_PIPE_RE = /\|\s*(\S*(?:ba|z|da|fi)?sh|node|python3?|powershell|pwsh|perl|ruby)\b/i

const RED_PATTERNS: [RegExp, string][] = [
  [/powershell[^\n|;]*\s(?:-enc|-e\b|-encodedcommand)\s/i, 'PowerShell base64 编码命令'],
  [/\b(Invoke-Expression|iex)\b/i, '动态执行（Invoke-Expression）'],
  [/\beval\s+["'$]/, '动态执行（eval）'],
  [/['"][A-Za-z0-9+/]{120,}={0,2}['"]/, '超长 base64 串（疑似混淆载荷）'],
  [/(?:\\x[0-9a-fA-F]{2}){20,}/, '十六进制串（疑似混淆）'],
  [/https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/i, '外联裸 IP 地址'],
  [/\b(?:nc|netcat|ncat)\b/, 'netcat 网络连接'],
  [/\b(printenv|env)\b[^;&|]*\|/, '环境变量被管道外传'],
  [/\b(?:whoami|hostname|uname)\b[^;&|]*(?:\||&&)[^;&|]*(?:curl|wget|fetch|nc\b)/i, '系统信息拼接进网络请求'],
  [/(?:curl|wget|fetch)\b[^\n]*\$\(\s*(?:whoami|hostname|uname|id|env|printenv)\b/i, '系统信息/环境信息拼接进网络请求'],
  [/\b(?:base64\s+(?:-d|--decode)|openssl\s+base64\s+-d|certutil\s+-decode)\b[^|]*\|/, '解码载荷被管道执行'],
  [/(\.bashrc|\.zshrc|\.profile|crontab\s|\/etc\/rc\.local|CurrentVersion\\+Run)/i, '写入持久化位置（shell 配置/cron/注册表自启）'],
]

const YELLOW_PATTERNS: [RegExp, string][] = [
  [/\bnode\s+(?:-e|--eval)\s/, '内联 node 脚本（-e）'],
  [/\bpython3?\s+-c\b/, '内联 python 脚本（-c）'],
  [/(-silent|-hidden|windowstyle\s+hidden|-NoWindow)/i, '隐藏窗口/静默执行参数'],
]

/** 完全无害的本地文件操作子命令：既无解释器也无网络时直接视为中性。 */
const LOCAL_ONLY_RE = /^(?:echo|mkdir|cp|mv|rm|ln|touch|chmod|test|\[|exit|cd|true|false|dir|copy|del|md)\b/i

/** 已知良性安装器（native 构建 / hooks / 预编译二进制标准链路）。 */
const KNOWN_INSTALLERS: [RegExp, string][] = [
  [/\bnode-gyp\b/, 'native 编译（node-gyp，标准工具链）'],
  [/\bprebuild-install\b|\bprebuild\b/, '预编译二进制下载（prebuild 链路）'],
  [/\bhusky\b/, 'git hooks 安装（husky）'],
  [/\bsimple-git-hooks\b/, 'git hooks 安装（simple-git-hooks）'],
  [/\bpino-pretty\b/, '日志格式化安装检查（pino-pretty）'],
]

/** 从脚本命令里提取它引用的本地 .js 文件路径（相对包目录）。
 * 兼容「node install/check」这类无扩展名引用——node 会自动解析到 check.js。 */
export function referencedScriptFiles(command: string): string[] {
  const out: string[] = []
  for (const sub of command.split(/\s*(?:&&|\|\||[;|])\s*/)) {
    if (!/\bnode\b/.test(sub) || /\bnode-gyp\b/.test(sub)) continue
    for (const m of sub.matchAll(/([\w@.\-\\/]+\.m?js)\b/g)) out.push(m[1].replace(/^[.\\/]+/, ''))
    const arg = sub.match(/\bnode\s+(?:-[^\s]+\s+)*([^\s'"]+)/)
    if (arg !== null && !arg[1].startsWith('-') && !arg[1].startsWith('$')) out.push(arg[1].replace(/^[.\\/]+/, ''))
  }
  return [...new Set(out)].slice(0, 3)
}

function domainsOf(text: string): string[] {
  const out: string[] = []
  const re = /https?:\/\/([^/:?\s'"`]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[1].toLowerCase())
  return [...new Set(out)]
}

/** 分析一段 install 脚本命令；files 为「相对路径 → 文件内容」（host 负责读取与限量）。 */
export function analyzeInstallScript(command: string, files: Record<string, string> = {}): ScriptAnalysis {
  const signals: ScriptSignal[] = []
  const subCommands = command.split(/\s*(?:&&|\|\||[;|])\s*/).filter((s) => s.trim().length > 0)

  // ── shell 层 ──
  for (const [re, text] of RED_PATTERNS) {
    if (re.test(command)) signals.push({ level: 'red', text })
  }
  for (const [re, text] of YELLOW_PATTERNS) {
    if (re.test(command)) signals.push({ level: 'yellow', text })
  }
  if (FETCHER_RE.test(command) && INTERPRETER_AFTER_PIPE_RE.test(command)) {
    signals.push({ level: 'red', text: '下载内容直接管道进解释器执行（curl|sh 模式）' })
  }
  if (SENSITIVE_PATH_RE.test(command)) {
    signals.push({ level: 'red', text: '触达敏感路径（凭据/密钥/浏览器数据）' })
  }
  for (const dom of domainsOf(command)) {
    if (KNOWN_DOWNLOAD_HOSTS.has(dom)) signals.push({ level: 'green', text: `外联已知分发域名 ${dom}` })
    else if (!/^\d+\.\d+\.\d+\.\d+$/.test(dom)) signals.push({ level: 'yellow', text: `外联非白名单域名 ${dom}（请人工确认）` })
  }
  let recognizedInstaller = false
  for (const [re, text] of KNOWN_INSTALLERS) {
    if (re.test(command)) {
      signals.push({ level: 'green', text })
      recognizedInstaller = true
    }
  }

  // ── 文件层：命令引用的本地 .js 逐个深挖 ──
  const filesRead: string[] = []
  const filesMissing: string[] = []
  for (const ref of referencedScriptFiles(command)) {
    const content = files[ref] ?? files[ref + '.js'] ?? files[ref + '/index.js']
    if (content === undefined) {
      filesMissing.push(ref)
      continue
    }
    filesRead.push(ref)
    const hasNet = /(?:https?\/\/|require\(['"]https?['"]\)|fetch\s*\(|net\.connect|https?\.request)/.test(content)
    const hasEnv = /process\.env/.test(content)
    const hasChild = /child_process|execSync|execFile|spawnSync|\bexec\s*\(/.test(content)
    if (/eval\s*\(|new\s+Function\s*\(/.test(content)) signals.push({ level: 'red', text: `${ref}：动态执行（eval/new Function）` })
    if (/['"][A-Za-z0-9+/]{160,}={0,2}['"]/.test(content)) signals.push({ level: 'red', text: `${ref}：内嵌超长 base64 串` })
    if (SENSITIVE_PATH_RE.test(content)) signals.push({ level: 'red', text: `${ref}：触达敏感路径` })
    const fileDomains = domainsOf(content)
    const hasUnknownDomain = fileDomains.some((d) => !KNOWN_DOWNLOAD_HOSTS.has(d))
    if (hasEnv && hasNet) {
      // GET 下载器读 env(代理/架构)是常态;POST/上传语义 + env 才是外传特征
      const hasPost = /method\s*[:=]\s*['"`]POST|\.post\s*\(|--data(?:-binary)?\b|FormData|\.send\s*\(/.test(content)
      if (hasPost) signals.push({ level: 'red', text: `${ref}：环境变量数据经 POST/上传发往外部（外传特征）` })
      else if (fileDomains.length === 0) signals.push({ level: 'red', text: `${ref}：发起网络请求但无可识别域名（疑似混淆）` })
      else if (hasUnknownDomain) signals.push({ level: 'yellow', text: `${ref}：读取环境变量并外联非白名单域名（请人工确认）` })
      else signals.push({ level: 'green', text: `${ref}：读取环境变量（配置用途）且仅外联已知分发域名` })
    }
    if (hasChild && hasNet) {
      if (hasUnknownDomain) signals.push({ level: 'yellow', text: `${ref}：子进程配合陌生域名网络请求` })
      else signals.push({ level: 'green', text: `${ref}：子进程仅配合已知分发域名（下载/校验链路）` })
    }
    if (hasEnv && !hasNet && !hasChild) signals.push({ level: 'green', text: `${ref}：仅读取环境变量（无网络/子进程行为）` })
    else if (hasEnv && !hasNet && hasChild) signals.push({ level: 'yellow', text: `${ref}：读取环境变量并调用子进程` })
    for (const dom of fileDomains) {
      if (KNOWN_DOWNLOAD_HOSTS.has(dom)) signals.push({ level: 'green', text: `${ref}：外联已知分发域名 ${dom}` })
      else signals.push({ level: 'yellow', text: `${ref}：外联非白名单域名 ${dom}` })
    }
    if (!hasNet && !hasEnv && !hasChild) signals.push({ level: 'green', text: `${ref}：本地脚本，无网络/环境变量/子进程信号` })
  }
  for (const ref of filesMissing) {
    signals.push({ level: 'yellow', text: `引用脚本 ${ref} 未能读取，建议人工检查` })
  }

  // ── 兜底：什么都没识别到时保持保守 ──
  if (signals.length === 0 && subCommands.length > 0) {
    const onlyLocal = subCommands.every((s) => LOCAL_ONLY_RE.test(s.trim()))
    if (onlyLocal) signals.push({ level: 'green', text: '仅本地文件操作' })
    else signals.push({ level: 'yellow', text: '未能识别的命令，建议人工检查' })
  }

  const verdict: ScriptVerdict =
    signals.some((s) => s.level === 'red') ? 'block'
      : signals.some((s) => s.level === 'yellow') ? 'warn'
        : (recognizedInstaller || signals.some((s) => s.level === 'green')) ? 'pass'
          : 'warn'

  return { verdict, signals, subCommands, filesRead, filesMissing }
}

/** 证据转为一行人类可读描述。 */
export function renderSignals(analysis: ScriptAnalysis): string {
  return analysis.signals.map((s) => `${s.level === 'red' ? '🚫' : s.level === 'yellow' ? '⚠️' : '✅'} ${s.text}`).join('；')
}
