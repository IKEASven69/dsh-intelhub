/**
 * install 生命周期脚本内容静态分析：把「带脚本=高危」改成证据分级（pass/warn/block）。
 * 纯函数、零宿主依赖；宿主侧负责读取脚本引用的本地 .js 文件后传入 files。
 * 判定质量对齐 research/2026-08-29-语料调研报告.md 的误报/漏报清单。
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
 * .env 用负向后行断言排除 process.env / import.meta.env 等属性访问(E2E 实测 esbuild 误报)。
 * Login Data / Chrome User Data 为浏览器凭据库(调研报告漏报#6)。 */
const SENSITIVE_PATH_RE =
  /(\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc|\.gnupg|\/etc\/passwd|cookies\.sqlite|Login[ _]Data|Chrome[^\n]{0,40}User Data|MetaMask|metamask|wallet\.dat|(?<![\w)])\.env\b)/i

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

/** node -e / python -c 内联载荷：提取引号内内容后按文件层规则深挖（调研报告漏报#1/#2/#6）。 */
const INLINE_PAYLOAD_RE =
  /\b(?:node\s+(?:-[^\s-]\s*\S*\s+)*-(?:e|-eval)\s+|node\s+--eval\s+|python3?\s+-c\s+)("([^"]*)"|'([^']*)'|`([^`]*)`)/

/** 标准 dev 工具链：install 时跑构建/清理/发布门控是常态（调研报告误报聚类 TOP）。
 * 只产生绿色信号、不会抵消任何红/黄；目的是避免「未能识别」兜底误警。 */
const DEV_TOOLS_RE =
  /\b(shx|tsc|rollup|gulp|make|tsup|babel|cross-env|rimraf|mkdirp|npm-run-all|run-s|run-p|dumi|bob|tshy|pkgroll|not-in-publish|in-publish|npmignore|skip-local-postinstall|lefthook|prek|lerna|nx|turbo|esbuild|swc|mocha|jest|vitest|nyc|eslint|prettier|stylelint|api-extractor|vite|webpack|ts-node|tsdx|microbundle|unbuild)\b/

/** 包管理器脚本委派：npm/yarn/pnpm/bun run <name>，目标脚本是包内 package.json 的 scripts 条目，
 * host 在真实安装场景可递归解析；语料离线场景视为中性。 */
const PKG_RUN_DELEGATION_RE = /\b(?:npm\s+(?:run\s+|test\b|start\b)|(?:yarn|pnpm|bun)\s+(?:run\s+)?)([\w:@.-]+)/

const NPX_RE = /\bnpx\s+([@\w./-]+)/

/** 完全无害的本地文件操作子命令：既无解释器也无网络时直接视为中性。 */
const LOCAL_ONLY_RE = /^(?:echo|mkdir|cp|mv|rm|ln|touch|chmod|test|\[|exit|cd|true|false|dir|copy|del|md|git\s+(?:restore|checkout|init))\b/i

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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 代码文本（引用文件或内联载荷）的行为信号分析。
 * @param ref 显示名（文件相对路径或「内联脚本(-e)」） */
function analyzeCodeContent(ref: string, content: string, signals: ScriptSignal[]): void {
  const hasNet = /(?:https?:\/\/|require\(['"]https?['"]\)|fetch\s*\(|net\.connect|https?\.request)/.test(content)
  const hasEnv = /process\.env/.test(content)
  const hasChild = /child_process|execSync|execFile|spawnSync|\bexec\s*\(|os\.system|subprocess/.test(content)
  if (/eval\s*\(|new\s+Function\s*\(/.test(content)) signals.push({ level: 'red', text: `${ref}：动态执行（eval/new Function）` })
  if (/['"][A-Za-z0-9+/]{160,}={0,2}['"]/.test(content)) signals.push({ level: 'red', text: `${ref}：内嵌超长 base64 串` })
  if (/['"][0-9a-fA-F]{32,}['"]/.test(content) && /Buffer\.from\s*\([^)]*,\s*['"]hex['"]/.test(content)) {
    signals.push({ level: 'red', text: `${ref}：十六进制串经 Buffer.from 解码（混淆载荷）` })
  }
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
    if (fileDomains.length === 0) signals.push({ level: 'red', text: `${ref}：子进程发起网络请求但无可识别域名（疑似拼接/混淆）` })
    else if (hasUnknownDomain) signals.push({ level: 'yellow', text: `${ref}：子进程配合陌生域名网络请求` })
    else signals.push({ level: 'green', text: `${ref}：子进程仅配合已知分发域名（下载/校验链路）` })
  }
  if (hasEnv && !hasNet && !hasChild) signals.push({ level: 'green', text: `${ref}：仅读取环境变量（无网络/子进程行为）` })
  else if (hasEnv && !hasNet && hasChild) signals.push({ level: 'yellow', text: `${ref}：读取环境变量并调用子进程` })
  for (const dom of fileDomains) {
    if (KNOWN_DOWNLOAD_HOSTS.has(dom)) signals.push({ level: 'green', text: `${ref}：外联已知分发域名 ${dom}` })
    else signals.push({ level: 'yellow', text: `${ref}：外联非白名单域名 ${dom}` })
  }
  if (!hasNet && !hasEnv && !hasChild) signals.push({ level: 'green', text: `${ref}：本地代码，无网络/环境变量/子进程信号` })
}

/** 分析一段 install 脚本命令；files 为「相对路径 → 文件内容」（host 负责读取与限量）。 */
export function analyzeInstallScript(command: string, files: Record<string, string> = {}): ScriptAnalysis {
  const signals: ScriptSignal[] = []
  const subCommands = command.split(/\s*(?:&&|\|\||[;|])\s*/).filter((s) => s.trim().length > 0)

  // ── shell 层 ──
  for (const [re, text] of RED_PATTERNS) {
    if (re.test(command)) signals.push({ level: 'red', text })
  }
  if (/(-silent|-hidden|windowstyle\s+hidden|-NoWindow)/i.test(command)) {
    signals.push({ level: 'yellow', text: '隐藏窗口/静默执行参数' })
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

  // ── 内联载荷层：node -e / python -c 的引号内容按代码文本深挖 ──
  const inlineMatches = [...command.matchAll(new RegExp(INLINE_PAYLOAD_RE.source, 'g'))]
  for (const m of inlineMatches) {
    const payload = m[2] ?? m[3] ?? m[4]
    const isPython = /^\s*python/.test(m[0])
    const label = isPython ? '内联 python 脚本（-c）' : '内联 node 脚本（-e）'
    // 载荷里连一个可分析的代码构造都没有（如 "x"）时保持保守黄线，不冒充看懂了
    const analyzable = payload !== undefined
      && /require\s*\(|\bimport\b|process\.|console\.|fs\.|child_process|eval|function|=>|os\.|subprocess|\bexec\b/.test(payload)
    if (analyzable) analyzeCodeContent(label, payload, signals)
    else signals.push({ level: 'yellow', text: `${label}：载荷无实质内容或未能解析（建议人工检查）` })
  }
  if (inlineMatches.length === 0
    && /\bnode\s+(?:-[^\s]+\s+)*-(?:e|-eval)\b|\bnode\s+--eval\b|\bpython3?\s+-c\b/.test(command)) {
    signals.push({ level: 'yellow', text: '内联 node/python 脚本：载荷未能解析（建议人工检查）' })
  }

  // ── 下载后执行链：fetcher -o 落盘，随后 chmod +x 或直接执行同一文件（调研报告漏报#7）──
  const downloaded: string[] = []
  for (const sub of subCommands) {
    if (!FETCHER_RE.test(sub)) continue
    for (const m of sub.matchAll(/(?:^|\s)(?:-o|--output)\s*=?\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
      const p = (m[1] ?? m[2] ?? m[3] ?? '').trim()
      if (p && !p.startsWith('-')) downloaded.push(p)
    }
  }
  if (downloaded.length > 0) {
    for (let i = 0; i < subCommands.length; i++) {
      const sub = subCommands[i]
      for (const p of downloaded) {
        const base = p.replace(/^.*[\\/]/, '')
        const asPath = new RegExp(`(?:^|&&|;|\\|\\|\\s*)\\s*["']?${escapeRe(p)}["']?\\b`)
        const asRel = new RegExp(`(?:^|&&|;|\\|\\|\\s*)\\s*["']?\\./?${escapeRe(base)}["']?\\b`)
        const executed = asPath.test(sub) || asRel.test(sub)
        const chmod = new RegExp(`chmod\\s+\\+x\\s+["']?${escapeRe(p)}["']?\\b`, 'i').test(sub)
          || new RegExp(`chmod\\s+\\+x\\s+["']?\\./?${escapeRe(base)}["']?\\b`, 'i').test(sub)
        if (executed || chmod) {
          signals.push({ level: 'red', text: `下载文件 ${base} 后提权/执行（download→exec 链）` })
          i = subCommands.length // 一个红信号足够
          break
        }
      }
    }
  }

  // ── npx：下载并执行远端包，保持黄线并给出解释 ──
  const npx = command.match(NPX_RE)
  if (npx !== null) signals.push({ level: 'yellow', text: `npx 将下载并执行远端包 ${npx[1]}（请人工确认）` })

  let recognizedInstaller = false
  for (const [re, text] of KNOWN_INSTALLERS) {
    if (re.test(command)) {
      signals.push({ level: 'green', text })
      recognizedInstaller = true
    }
  }
  const delegation = command.match(PKG_RUN_DELEGATION_RE)
  if (delegation !== null) signals.push({ level: 'green', text: `调用包内脚本 ${delegation[1]}（package.json scripts 委派）` })
  if (DEV_TOOLS_RE.test(command)) signals.push({ level: 'green', text: '标准构建/发布工具链命令' })

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
    analyzeCodeContent(ref, content, signals)
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
