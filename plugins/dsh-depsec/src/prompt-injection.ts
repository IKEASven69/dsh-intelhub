/**
 * 装前提示注入内容检测：扫会被注入模型上下文的 markdown（SKILL.md / commands / agents）。
 * 依据 research/2026-09-01-v0.5设计文档.md：竞品（trust-check/poison-guard/plugin-guard）
 * 均不读 markdown 内容恶意性，secure-audit 的规则表分类学与对抗工程（同形字/零宽/base64 变体）
 * 借鉴于此，但目标不同——本模块是装前静态审计，不是运行时对话流扫描。
 * 纯函数、零宿主依赖。@module dsh-depsec/prompt-injection
 */

export type InjectionVerdict = 'pass' | 'warn' | 'block'

export interface InjectionFinding {
  file: string
  line: number
  category: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  snippet: string
  /** 命中来源变体：plain / normalized / base64（对抗变形的取证信息） */
  via?: 'plain' | 'normalized' | 'base64'
}

export interface InjectionScanResult {
  verdict: InjectionVerdict
  findings: InjectionFinding[]
  /** 文件级外联目的地（URL host 集合，小写）。 */
  egress: string[]
}

/** 单条规则。directional=true 的规则要求同文件存在靶标语境（URL/webhook/凭据词）才生效。 */
interface InjectionRule {
  id: string
  category: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  /** 是否要求同文件存在靶标语境才生效（防「技能教 curl 用法」误报） */
  directional?: boolean
  re: RegExp
}

/** 靶标语境：外传/执行类指令只有指向具体目的地或凭据对象才 actionable。 */
const TARGET_RE = /https?:\/\/|webhook|discord\.com\/api|telegram\.org|t\.me\/|\bapi[_-]?key\b|\btoken\b|环境变量|env(?!o)\b|凭据|密钥|credentials?|secret/i

/** 规则表：双语。锚定行为动词 + 对象，避免裸名词误报。 */
const RULES: InjectionRule[] = [
  // ── 隐蔽性标记（本身 high；与外传/执行类同文件共现升 block）──
  { id: 'stealth-hide', category: 'stealth', severity: 'high', re: /(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention)\s+(?:the\s+)?user\s+(?:about\s+)?(?:this|it|that|these|them)\b|hide\s+(?:this|it|that|these)\s+from\s+(?:the\s+)?user|(?:silently|secretly|covertly|quietly)\s+(?:post|send|upload|exec|run)|without\s+(?:telling|informing|notifying)\s+(?:the\s+)?user/i },
  { id: 'stealth-cn-hide', category: 'stealth', severity: 'high', re: /(?:不要|别|勿)(?:告诉|告知|提醒)\s*(?:用户)?\s*(?:关于)?(?:这|该|此|本次)|(?:对用户|向用户)\s*(?:隐瞒|保密)|(?:悄悄|偷偷|静默|暗中)(?:地)?(?:执行|发送|上传|调用|post|send|upload|curl)/i },
  // ── 凭据外传指令（directional：需靶标；凭据词与动词间允许跨句，逐行窗口）──
  { id: 'exfil-credential', category: 'exfil', severity: 'critical', directional: true, re: /(?:send|post|upload|transmit|forward|exfiltrate)\b[^\n]{0,120}(?:api[\s_-]*keys?|tokens?|credentials?|secrets?|\.env\b|ssh[\s_-]*keys?|private[\s_-]*keys?|env(?:ironment)?[\s_-]*variables?)/i },
  { id: 'exfil-cn-credential', category: 'exfil', severity: 'critical', directional: true, re: /(?:把|将|读取|收集)[^\n]{0,60}(?:api[\s_-]*key|密钥|凭据|token|环境变量|\.env)[^\n]{0,80}(?:发送?|上传|提交|转发|外传|传到|传出)/i },
  { id: 'exfil-curl-target', category: 'exfil', severity: 'critical', directional: true, re: /(?:curl|wget|fetch|XMLHttpRequest|axios)[^\n]{0,80}(?:--data|-d\s|\.post\(|body\s*:)[^\n]{0,80}(?:process\.env|\$\{|\.env\b|密钥|token|凭据|Authorization)/i },
  // ── 指令覆盖 ──
  { id: 'override-ignore', category: 'override', severity: 'high', re: /(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|messages?)/i },
  { id: 'override-cn-ignore', category: 'override', severity: 'high', re: /(?:忽略|无视|忘掉)[^\n]{0,12}(?:之前|以上|前面|上面|先前)[^\n]{0,8}(?:所有|全部|的)?[^\n]{0,6}(?:指令|指示|提示|规则|要求)/ },
  { id: 'override-guardrails', category: 'override', severity: 'critical', re: /(?:bypass|disable|remove|override|turn\s+off)\s+(?:all\s+|your\s+|the\s+)?(?:safety|guardrails?|restrictions?|content\s+filter)/i },
  { id: 'override-cn-guardrails', category: 'override', severity: 'critical', re: /(?:绕过|关闭|解除|破解)[^\n]{0,8}(?:安全|审核|限制|护栏)[^\n]{0,6}(?:机制|系统|检查)?/ },
  // ── 越权执行（directional：需靶标）──
  { id: 'exec-arbitrary', category: 'exec', severity: 'high', directional: true, re: /(?:run|execute)\s+(?:arbitrary|any|malicious|dangerous|unrestricted)\s+(?:commands?|code|shell)/i },
  { id: 'exec-cn-arbitrary', category: 'exec', severity: 'high', directional: true, re: /(?:执行|运行)[^\n]{0,10}(?:任意|恶意|危险|不受限制的?)[^\n]{0,6}(?:命令|代码|脚本)/ },
  { id: 'exec-remote-pipe', category: 'exec', severity: 'high', re: /(?:curl|wget|irm|iwr|Invoke-WebRequest)[^\n]*\|\s*(?:ba|z|da|fi)?sh\b/i },
  { id: 'exec-destructive', category: 'exec', severity: 'high', re: /rm\s+-rf\s+[~/]|[Ff]orce\s+push\s+--no-verify|git\s+push\s+--force\s+origin\s+master/ },
  // ── 伪权威（medium：合理技能也可能引用 system 格式，需围栏外裸行）──
  { id: 'fake-authority', category: 'authority', severity: 'medium', re: /^\s*(?:\[?(?:SYSTEM|ADMIN|DEVELOPER|OPERATOR)(?:[_ -]?(?:MESSAGE|NOTE|OVERRIDE))?\]?\s*[:：]|<{2,}\s*(?:SYSTEM|ADMIN)\s*(?:PROMPT|MESSAGE)?\s*>{2,})/ },
  { id: 'fake-authority-cn', category: 'authority', severity: 'medium', re: /^\s*(?:【?\s*(?:系统消息|管理员|开发者消息|官方通知)\s*】?\s*[:：])/ },
  // ── 持久化渗透 ──
  { id: 'persist-config', category: 'persist', severity: 'medium', re: /(?:append|add|write)\s+(?:this|the\s+following)\s+(?:to|into)\s+(?:your\s+)?(?:CLAUDE\.md|AGENTS\.md|memory|config(?:uration)?\s+files?)/i },
  { id: 'persist-cn-config', category: 'persist', severity: 'high', re: /每次会话[^\n]{0,20}(?:先|都|自动)(?:读取|执行)[^\n]{0,40}(?:\.npmrc|\.ssh|\.env|凭据|密钥)/ },
  { id: 'persist-cn-config-plain', category: 'persist', severity: 'medium', re: /(?:写入|添加到|追加到)[^\n]{0,16}(?:CLAUDE\.md|AGENTS\.md|全局配置|记忆库)|每次会话[^\n]{0,20}(?:先|都|自动)(?:执行|调用|读取)/ },
  // ── 解码执行 ──
  { id: 'decode-exec', category: 'decode', severity: 'high', directional: true, re: /(?:base64|hex|atob|Buffer\.from)[^\n]{0,40}(?:decode|解码)[^\n]{0,40}(?:then\s+)?(?:run|execute|eval|执行|运行)|(?:解码|decode)[^\n]{0,20}(?:后|then)[^\n]{0,10}(?:执行|运行|eval)/i },
]

// ── 反混淆 pre-pass（借鉴 secure-audit / mcpguard，有界变体）──

/** 同形字 → ASCII：西里尔 + 希腊 omicron。 */
const HOMOGLYPH_MAP: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ο': 'o',
}
// 数学字母数字符号区（U+1D400–U+1D7D6）：粗体/斜体/手写体等字母肉眼与 ASCII 全同，
// 是 mcpguard 已用、我们此前缺失的混淆通道（对标补齐）。
function addMathBlock(start: number, asciiStart: number, count: number): void {
  for (let i = 0; i < count; i++) HOMOGLYPH_MAP[String.fromCodePoint(start + i)] = String.fromCharCode(asciiStart + i)
}
// 每个字块：大写区 + 小写区（紧跟大写区后 26 个码点）
const MATH_BLOCKS: Array<[number, number, number]> = [
  [0x1d400, 65, 26], [0x1d41a, 97, 26], // 𝐀 bold
  [0x1d434, 65, 26], [0x1d44e, 97, 26], // 𝐴 italic
  [0x1d468, 65, 26], [0x1d482, 97, 26], // 𝑨 bold-italic
  [0x1d49c, 65, 26], [0x1d4b6, 97, 26], // 𝒜 script
  [0x1d538, 65, 26], [0x1d552, 97, 26], // 𝔸 double-struck
  [0x1d56c, 65, 26], [0x1d586, 97, 26], // 𝕬 bold fraktur
  [0x1d5a0, 65, 26], [0x1d5ba, 97, 26], // 𝖠 sans
  [0x1d5d4, 65, 26], [0x1d5ee, 97, 26], // 𝗔 sans bold
  [0x1d608, 65, 26], [0x1d622, 97, 26], // 𝘈 sans italic
  [0x1d63c, 65, 26], [0x1d656, 97, 26], // 𝘼 sans bold-italic
  [0x1d670, 48, 10], // 𝟎–𝟵 mono digits
]
for (const [start, ascii, count] of MATH_BLOCKS) addMathBlock(start, ascii, count)
const NEEDS_NORMALIZE_RE_SRC = '[\\u200b-\\u200d\\u2060\\ufeff\\uff01-\\uff5e\\u0430\\u0435\\u043E\\u0440\\u0441\\u0445\\u0443\\u0456\\u03BF\\u{1D400}-\\u{1D7D6}]'
// u 旗标必须：星面区（U+1D400+）的 \u{...} 语法依赖它，无 u 时 \u1D400 只吃 4 位十六进制
const NEEDS_NORMALIZE_RE = new RegExp(NEEDS_NORMALIZE_RE_SRC, 'u')

/** 零宽剥离 + 全角→半角 + 同形字归一（查表，含数学字母区）。无需归一时原样返回（快路径）。 */
export function normalizeText(text: string): string {
  if (!NEEDS_NORMALIZE_RE.test(text)) return text
  return text
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u0430\u0435\u043E\u0440\u0441\u0445\u0443\u0456\u03BF\u{1D400}-\u{1D7D6}]/gu, (ch) => HOMOGLYPH_MAP[ch] ?? ch)
}

/** 有界 base64 变体：token ≥16 字符且解码后 ≥80% 可打印才算（防 hash/订单号噪声），最多 3 个。 */
export function base64Variants(text: string): { text: string; via: 'base64' }[] {
  const out: { text: string; via: 'base64' }[] = []
  const re = /[A-Za-z0-9+/]{24,}={0,2}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null && out.length < 3) {
    const token = m[0]
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8')
      if (decoded.length < 8 || decoded === token) continue
      let printable = 0
      for (const ch of decoded) {
        const c = ch.codePointAt(0) ?? 0
        // CJK 视作可打印：中文指令的 base64 是双语场景常态，ASCII-only 门会整类漏掉
        if ((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13 || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f)) printable++
      }
      if (printable / decoded.length >= 0.8) out.push({ text: decoded, via: 'base64' })
    } catch { /* 非法 base64，跳过 */ }
  }
  return out
}

interface VariantText {
  text: string
  via: 'plain' | 'normalized' | 'base64'
  /** 每个变体自己的行切分（base64 解码后的"行"没有原文行号意义，记 0 由调用方处理） */
  fenceMask?: boolean[]
}

/** 代码围栏掩码：``` 围栏内的行为 true（命中降级用）。 */
function fenceMaskOf(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence
      mask[i] = inFence
      continue
    }
    mask[i] = inFence
  }
  return mask
}

function snippetAt(text: string, index: number, matched: string): string {
  const start = Math.max(0, index - 30)
  const end = Math.min(text.length, index + matched.length + 30)
  return text.slice(start, end).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const

/** 降一级查表（low 到底）。 */
const DOWN = { low: 'low', medium: 'low', high: 'medium', critical: 'high' } as const

/** 否定/举例语境：安全警告引用反面示例时命中不算数。 */
const NEGI_RE = /(?:do\s+not|don'?t|never|instead|rather\s+than|e\.g\.|for\s+example|反面示例|切勿模仿|仅供参考|而不是)/i

/** 命中位置是否落在行内反引号（`...`）里。 */
function insideInlineCode(line: string, index: number): boolean {
  let ticks = 0
  for (let i = 0; i < index && i < line.length; i++) if (line[i] === '`') ticks++
  return ticks % 2 === 1
}

/** 分析一个会被注入模型上下文的 markdown 文件。 */
export function scanInjectedText(file: string, content: string): InjectionScanResult {
  const findings: InjectionFinding[] = []
  const egressHosts = new Set<string>()

  // 变体集：原文 → 归一化（仅当有变化）→ 有界 base64 解码
  const rawLines = content.split('\n')
  const rawMask = fenceMaskOf(rawLines)
  const variants: VariantText[] = [{ text: content, via: 'plain', fenceMask: rawMask }]
  const normalized = normalizeText(content)
  if (normalized !== content) {
    const nl = normalized.split('\n')
    variants.push({ text: normalized, via: 'normalized', fenceMask: fenceMaskOf(nl) })
  }
  for (const b64 of base64Variants(content)) {
    if (variants.length >= 5) break
    variants.push(b64)
  }

  for (const variant of variants) {
    const lines = variant.text.split('\n')
    const mask = variant.fenceMask ?? new Array<boolean>(lines.length).fill(false)
    const hasTarget = TARGET_RE.test(variant.text)

    for (const rule of RULES) {
      if (rule.directional && !hasTarget) continue
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(rule.re)
        if (m === null) continue
        // directional 规则还要求命中行本身或邻近有靶标（防全文偶见 URL 的误报）
        if (rule.directional && !TARGET_RE.test(lines[i]) && !TARGET_RE.test(lines[i + 1] ?? '') && !TARGET_RE.test(lines[i - 1] ?? '')) continue
        // exfil 豁免：凭据词是 URL 查询参数（?access_token=...）或 API 文档形态时不是外传
        if (rule.category === 'exfil') {
          const span = m[0]
          if (/(?:token|key|credential|secret|凭据|密钥)\s*=[^=]/i.test(span) && /https?:\/\//i.test(span)) continue
          if (/https?:\/\/[^\s]*=(?:ACCESS_)?(?:TOKEN|KEY)/i.test(span)) continue
        }
        const idx = lines[i].indexOf(m[0] ?? '')
        let severity: InjectionFinding['severity'] = rule.severity
        // 降级序：directional 规则围栏内→low；否定语境（安全警告里的反面示例）→降一级；
        // 围栏内其余规则→降一级；命中落在行内反引号（inline code）→降两级。
        const negated = NEGI_RE.test(lines[i]) || NEGI_RE.test(lines[i - 1] ?? '')
        if (rule.directional === true && mask[i]) severity = 'low'
        else if (negated && severity !== 'low') severity = DOWN[severity]
        else if (mask[i] && severity !== 'low') severity = DOWN[severity]
        // 行内反引号内、或紧跟反引号词元（`--force` to bypass… 这类「描述 flag 能力」形态）→ 降两级
        const adjacentCode = idx >= 0 && new RegExp('[^`\\n]{0,40}`\\s*(?:to|用于|来|可|支持)?\\s*$').test(lines[i].slice(0, idx))
        if (idx >= 0 && (insideInlineCode(lines[i], idx) || adjacentCode) && severity !== 'low') severity = DOWN[DOWN[severity]]
        findings.push({
          file,
          line: variant.via === 'plain' ? i + 1 : 0,
          category: rule.category,
          severity,
          snippet: snippetAt(variant.text, idx >= 0 ? idx : 0, m[0] ?? lines[i]),
          ...(variant.via !== 'plain' ? { via: variant.via } : {}),
        })
      }
    }

    // egress 目的地（任何变体里出现的 URL host）
    for (const m of variant.text.matchAll(/https?:\/\/([^/:?\s'"`<>)]+)/g)) egressHosts.add(m[1].toLowerCase())
  }

  // ── 判定聚合：共现升级（设计文档三闸之三）──
  const categoriesHigh = new Set(findings.filter((f) => SEV_RANK[f.severity] >= SEV_RANK.high).map((f) => f.category))
  const hasStealth = findings.some((f) => f.category === 'stealth' && SEV_RANK[f.severity] >= SEV_RANK.high)
  const hasAction = findings.some((f) => ['exfil', 'exec', 'override', 'decode'].includes(f.category) && SEV_RANK[f.severity] >= SEV_RANK.high)
  let verdict: InjectionVerdict
  if (findings.some((f) => f.severity === 'critical')) verdict = 'block'
  else if (hasStealth && hasAction) verdict = 'block'
  else if (categoriesHigh.size >= 2) verdict = 'block'
  else if (categoriesHigh.size === 1) verdict = 'warn'
  else if (new Set(findings.filter((f) => SEV_RANK[f.severity] === SEV_RANK.medium).map((f) => f.category)).size >= 2) verdict = 'warn'
  else verdict = 'pass'

  // 去重（同 file+line+category 只留最重）
  const seen = new Map<string, InjectionFinding>()
  for (const f of findings) {
    const key = `${f.line}|${f.category}`
    const prev = seen.get(key)
    if (prev === undefined || SEV_RANK[f.severity] > SEV_RANK[prev.severity]) seen.set(key, f)
  }
  return { verdict, findings: [...seen.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 40), egress: [...egressHosts] }
}

/** 该相对路径是否是「会注入模型上下文」的文件（扫描面判定）。 */
export function isModelFacingFile(path: string): boolean {
  const lower = path.toLowerCase().replace(/\\/g, '/')
  return /(^|\/)skills?\/.*\.md$/.test(lower)
    || /(^|\/)skills?\/.*\.txt$/.test(lower)
    || /(^|\/)commands?\/.*\.md$/.test(lower)
    || /(^|\/)agents?\/.*\.md$/.test(lower)
    || /skill\.md$/.test(lower)
    || /\.prompt$/.test(lower)
}
