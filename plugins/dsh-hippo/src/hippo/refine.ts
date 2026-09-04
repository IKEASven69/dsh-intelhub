/**
 * LLM 蒸馏精炼：规则粗筛（extractCandidates）产出候选后，用 LLM 做
 * 语义判决——保留/丢弃/改写为自包含记忆。两段式架构（规则管召回、
 * LLM 管精度）是 mem0 等记忆系统验证过的做法；纯规则的局限（过程
 * 自语/分析流水账含触发词即被抓）由 LLM 判决兜底。
 *
 * 设计约束：
 * - LLM 不可用/超时/输出解析失败 → 原样返回候选（退回纯规则，绝不阻塞蒸馏）
 * - 一批候选一次调用（MAX_CANDIDATES=20），几百 token，成本可忽略
 * - 输出防御性解析：只接受合法 JSON 数组，未出现的编号按"保留原样"处理
 *   （宁多勿丢——LLM 漏判的候选走原有阈值分流）
 */
import type { Candidate } from './distill.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { appPath } from '../core/paths.js'

/** 精炼审计日志（~/.hippo/llm-refine.log）：每批一行——dsh 宿主吞 console，
 *  文件是唯一可靠的可观测面；也是产品级审计数据。 */
function audit(line: string): void {
  try {
    const dir = process.env.HIPPO_DATA_DIR ?? join(homedir(), '.hippo')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'llm-refine.log'), `${new Date().toISOString()} ${line}
`)
  } catch { /* 审计失败不影响主流程 */ }
}

export interface CompleteOpts { temperature?: number }
export type CompleteFn = (system: string, user: string, opts?: CompleteOpts) => Promise<string>

// ── few-shot 样例库（H12 M-02）：人工判决随积累回填，压缩质量随使用变好 ──

export interface RefineSample { text: string; verdict: 'accept' | 'discard'; reason?: string; source?: string }

/** 样例库路径（~/.hippo/refine-samples.jsonl）。 */
export function samplesPath(): string {
  const dir = process.env.HIPPO_DATA_DIR ?? join(homedir(), '.hippo')
  return join(dir, 'refine-samples.jsonl')
}

/** 读样例（文件不存在/坏行容错）。 */
export function loadSamples(path?: string): RefineSample[] {
  const p = path ?? samplesPath()
  if (!existsSync(p)) return []
  const out: RefineSample[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      const d = JSON.parse(t) as RefineSample
      if (typeof d.text === 'string' && (d.verdict === 'accept' || d.verdict === 'discard')) out.push(d)
    } catch { /* 坏行跳过 */ }
  }
  return out
}

/** 追加样例（refine-learn 命令用）。 */
export function appendSamples(samples: RefineSample[], path?: string): void {
  const p = path ?? samplesPath()
  const prev = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const lines = samples.map((x) => JSON.stringify(x)).join('\n')
  writeFileSync(p, (prev.endsWith('\n') || prev === '' ? prev : prev + '\n') + lines + '\n', 'utf-8')
}

/** 挑 K 条多样样例（收/弃各半，文本去重）。 */
export function pickDiverse(samples: RefineSample[], k = 6): RefineSample[] {
  const seen = new Set<string>()
  const uniq = samples.filter((x) => {
    const key = x.text.slice(0, 40)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const half = Math.max(1, Math.floor(k / 2))
  const acc = uniq.filter((x) => x.verdict === 'accept')
  const dis = uniq.filter(x => x.verdict === 'discard')
  return [...acc.slice(0, half), ...dis.slice(0, k - Math.min(half, acc.length))].slice(0, k)
}

/** few-shot 块（无样例返回空串）。 */
export function fewShotBlock(samples: RefineSample[]): string {
  if (samples.length === 0) return ''
  const rows = samples.map((x) =>
    `- ${x.verdict === 'accept' ? '[收]' : '[弃]'} "${x.text.slice(0, 60)}"${x.reason ? ` —— ${x.reason}` : ''}`,
  )
  return '\n\n以下是你之前判过的真实例子（本机历史判决，照此口径）：\n' + rows.join('\n')
}

const SYSTEM_PROMPT = `你是记忆库审核员。判断每条从 AI 编程会话提取的候选是否值得作为**长期记忆**（未来新会话能让 agent 做得更好/避坑）。

必须 k:false 的：过程自语（"再决定"/"让我先看"）、指代不明的碎片（括号、表格行、列表符号）、疑问句、与项目无关的废话。
**实战新增必丢三类**（来自 388 条人工批审验证）：① 工具报错日志（"操作失败:"/error/exit code 开头的调用参数转贴）；② 调研转贴——assistant 引用的公开文档/竞品分析/网上的设计规范（公开知识不是用户特有记忆）；③ 调试推理碎片——逐句分析代码的中间思考（"Now/Actually/Wait/Hmm"开头的英文自言自语）。
值得保留的：具体技术决策、根因教训、用户偏好、技术事实；指代不明的但信息可救的改写为自包含一句。**同一 bug 的多条碎片只留最完整一条**（改写凝练,其余 k:false）;项目归属太粗时（如目录名 CodingProjects）用 "p" 修正为真实项目名。
宁枉勿纵：拿不准就 k:false——垃圾记忆污染召回的代价大于漏存（实测规则粗筛 598 条仅约 4% 值得留）。

示例：
输入: 0.[decision] 然后再决定  1.[lesson] 端口是 3456，测试都走这个口  2.[decision] （这决定写法）
输出: [{"i":0,"k":false},{"i":1,"k":true},{"i":2,"k":false}]

只输出 JSON 数组：[{"i":编号,"k":true|false,"t":"改写文本","y":"fact|decision|lesson|preference","p":"修正项目名"}]，t/y/p 仅保留时可选。未列出的编号视为保留。`

/** 防御性解析 LLM 输出 → 按 i 索引的判决表。 */
export function parseVerdicts(rawInput: string): Map<number, { keep: boolean; text?: string; type?: string; project?: string }> {
  const verdicts = new Map<number, { keep: boolean; text?: string; type?: string; project?: string }>()
  // 思考模型（MiniMax-M3 / qwen3.5 等）先吐 <think>…</think>，思考里出现
  // 的 "[" 会污染首尾截取——只取最后一个 </think> 之后的内容再解析。
  const lastThink = rawInput.lastIndexOf('</think>')
  const raw = lastThink >= 0 ? rawInput.slice(lastThink + '</think>'.length) : rawInput
  // 容错：模型可能把 JSON 包在 ```json 围栏或前后废话里
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return verdicts
  let arr: unknown
  try {
    arr = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return verdicts
  }
  if (!Array.isArray(arr)) return verdicts
  const TYPES = new Set(['fact', 'decision', 'lesson', 'preference'])
  for (const v of arr) {
    if (typeof v !== 'object' || v === null) continue
    const { i, k, t, y, p } = v as Record<string, unknown>
    if (typeof i !== 'number' || !Number.isInteger(i) || typeof k !== 'boolean') continue
    verdicts.set(i, {
      keep: k,
      text: typeof t === 'string' && t.trim() !== '' ? t.trim().slice(0, 400) : undefined,
      type: typeof y === 'string' && TYPES.has(y) ? y : undefined,
      project: typeof p === 'string' && p.trim() !== '' ? p.trim().slice(0, 60) : undefined,
    })
  }
  return verdicts
}

/**
 * 用 LLM 精炼候选清单。complete 抛错/超时/输出垃圾 → 原样返回（纯规则降级）。
 */
export async function llmRefine(candidates: Candidate[], complete: CompleteFn, timeoutMs = 60_000): Promise<Candidate[]> {
  if (candidates.length === 0) return candidates
  // few-shot（H12 M-02）：人工判决样例随积累注入——压缩质量随使用变好
  const system = SYSTEM_PROMPT + fewShotBlock(loadSamples())
  const numbered = candidates
    .map((c, i) => `${i}. [${c.type}] ${c.text}`)
    .join('\n')
  let raw: string
  try {
    raw = await complete(system, numbered, { temperature: 0 })
  } catch (e) {
    audit(`FAIL ${(e as Error).message?.slice(0, 100)}`)
    return candidates // LLM 不可用：纯规则降级
  }
  const verdicts = parseVerdicts(raw)
  if (verdicts.size === 0) { audit(`UNPARSEABLE raw=${JSON.stringify(raw).slice(0, 300)}`); return candidates } // 输出解析失败：降级
  const kept = candidates.filter((_, i) => { const v = verdicts.get(i); return v === undefined || v.keep }).length
  audit(`OK ${candidates.length} 候选 → 保留 ${kept} 丢弃 ${candidates.length - kept}（判决 ${verdicts.size}）`)

  const out: Candidate[] = []
  candidates.forEach((c, i) => {
    const v = verdicts.get(i)
    if (v === undefined || v.keep) {
      // 保留（含 LLM 漏判的）：应用改写文本/类型修正
      if (v?.text !== undefined || v?.type !== undefined || v?.project !== undefined) {
        out.push({
          ...c,
          text: v.text ?? c.text,
          type: v.type ?? c.type,
          project: v.project ?? c.project,
          confidence: Math.min(1, c.confidence + 0.1), // LLM 背书略提置信度
          source_rule: `${c.source_rule}+llm`,
        })
      } else {
        out.push(c)
      }
    }
    // v.keep === false：丢弃
  })
  return out
}
