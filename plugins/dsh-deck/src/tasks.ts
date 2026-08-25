/**
 * 任务卡协议（D3）：TASK.md = 多张卡以空行包围的 `---` 分隔；每卡自带平铺
 * frontmatter（id/type/status/engine/title/created/acceptance）。acceptance 存
 * fm 单字段（；分隔），解析时回退读 body 的「## 验收」checkbox。
 * 状态机 queued→running→review→done|failed 由 zcode（agent）与工作台共同驱动。
 * fs 注入可测。@module dsh-deck/tasks
 */
import { join } from 'node:path'
import { parseDoc, serializeDoc } from './frontmatter.ts'

export type TaskStatus = 'queued' | 'running' | 'review' | 'done' | 'failed'
export type TaskType = 'research' | 'article' | 'video' | 'ppt'

export const TASK_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'review', 'done', 'failed']
export const TASK_TYPES: readonly TaskType[] = ['research', 'article', 'video', 'ppt']

export interface TaskCard {
  id: string
  type: TaskType
  status: TaskStatus
  engine: string
  title: string
  created: string
  acceptance: string[]
  body: string
}

export interface TaskFs {
  read(path: string): string | null
  write(path: string, content: string): void
  exists(path: string): boolean
  mkdirs(path: string): void
}

/** 与 adoptIdea 的追加方式保持一致：卡之间用空行包围的 `---` 分隔。 */
export function splitCards(md: string): string[] {
  return md.split(/\r?\n\s*\r?\n---\r?\n/)
    .map((c) => c.trim())
    .filter((c) => c.startsWith('---'))
}

export function parseTaskDoc(md: string): TaskCard[] {
  const cards: TaskCard[] = []
  for (const chunk of splitCards(md)) {
    const { data, body } = parseDoc(chunk + '\n')
    const b = body.trim()
    const id = (data.id ?? '').trim()
    if (id === '') continue
    let acceptance = splitAcceptance(data.acceptance ?? '')
    if (acceptance.length === 0) acceptance = acceptanceFromBody(b)
    cards.push({
      id,
      type: (TASK_TYPES as readonly string[]).includes(data.type) ? (data.type as TaskType) : 'research',
      status: (TASK_STATUSES as readonly string[]).includes(data.status) ? (data.status as TaskStatus) : 'queued',
      engine: data.engine || 'zcode',
      // 规范：标题不重复存 body——serializeCard 统一以 H1 携带，解析时剥离
      title: (data.title ?? '').trim() || firstHeading(b) || id,
      created: data.created ?? '',
      acceptance,
      body: b.replace(/^#\s+.*(\r?\n|$)/, '').trim(),
    })
  }
  return cards
}

export function serializeCard(card: TaskCard): string {
  const fm: Record<string, string> = {
    id: card.id,
    type: card.type,
    status: card.status,
    engine: card.engine || 'zcode',
    title: card.title,
    created: card.created,
    acceptance: card.acceptance.join('；'),
  }
  return serializeDoc(fm, `# ${card.title}\n\n${card.body}\n`)
}

export function serializeCards(cards: readonly TaskCard[]): string {
  return cards.map(serializeCard).join('\n\n---\n\n')
}

export function newTaskId(now: Date, taken: readonly string[]): string {
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const base = `T-${day}-`
  let n = 1
  while (taken.includes(base + String(n).padStart(2, '0'))) n++
  return base + String(n).padStart(2, '0')
}

/** 追加或按 id 替换一张卡，返回新文档。 */
export function upsertCard(md: string, card: TaskCard): string {
  const cards = parseTaskDoc(md)
  const idx = cards.findIndex((c) => c.id === card.id)
  if (idx === -1) cards.push(card)
  else cards[idx] = card
  return serializeCards(cards)
}

/** 改一张卡的状态；找不到返回 null。 */
export function setCardStatus(md: string, id: string, status: TaskStatus): string | null {
  const cards = parseTaskDoc(md)
  const card = cards.find((c) => c.id === id)
  if (card === undefined) return null
  card.status = status
  return serializeCards(cards)
}

export function makeCard(input: { id: string; title: string; type?: TaskType; acceptance?: readonly string[]; body?: string }, now: Date): TaskCard {
  const title = input.title.trim().slice(0, 120)
  return {
    id: input.id,
    type: input.type ?? 'research',
    status: 'queued',
    engine: 'zcode',
    title,
    created: now.toISOString().slice(0, 10),
    acceptance: (input.acceptance ?? []).map((a) => a.trim().slice(0, 200)).filter((a) => a !== '').slice(0, 20),
    body: (input.body ?? '').trim() === '' ? `题目：${title}` : input.body!.trim(),
  }
}

export const AGENTS_MD = `# zcode 接单规则（dsh-deck 自动写入 · v2）

<!-- deck:agents:v2 -->

开工前必读，按顺序执行：

1. 读本目录 TASK.md，找 frontmatter 里 \`status: queued\` 的卡（一次只接一张）。
2. 把该卡的 status 改成 \`running\`（只改这一个词，别动其他内容）。
3. 按卡内 acceptance（验收）逐条干活；结论要带来源（URL 或文件路径）。
4. 完成后在项目根写 RESULT.md，格式必须如下（审阅台按它解析）：
   \`\`\`
   ---
   task: <卡id>
   type: research
   summary: 一句话结论
   ---

   # <卡题目>

   ## 判断
   - 每条一行、一句话能复述的判断（审阅台勾选这些落库，写清楚写扎实）
   - ……

   ## 来源
   - https://… 或 文件路径 —— 一句话说明

   ## 过程（可选）
   干了什么、跳过了什么。
   \`\`\`
   如有可视化产物，另写 widget-result.json：
   \`{"task":"<卡id>","windows":[{"target":"main","kind":"html|url|file","path|url|html":"…"}],"generatedAt":"…"}\`
5. 把该卡 status 改成 \`review\`，停下等人工审阅落库（落库由人勾选，不要代劳）。

失败处理：status 改 \`failed\`，并在 RESULT.md 写明原因。
红线：不要改 knowledge-base 其他文件；不要自动发布任何内容。
`

/** 已是我们生成的旧版（无 v2 标记）→ 自动升级；用户改过（标题不符）→ 不动。 */
export function ensureAgentsMd(fs: TaskFs, root: string): boolean {
  const p = join(root, 'AGENTS.md')
  const existing = fs.read(p)
  if (existing !== null) {
    if (existing.includes('deck:agents:v2')) return false
    if (!existing.includes('zcode 接单规则（dsh-deck 自动写入')) return false
  }
  fs.mkdirs(root)
  fs.write(p, AGENTS_MD)
  return true
}

function splitAcceptance(v: string): string[] {
  return v.split(/[；;]/).map((s) => s.trim()).filter((s) => s !== '')
}

function acceptanceFromBody(body: string): string[] {
  const lines = body.split(/\r?\n/)
  const out: string[] = []
  let inSection = false
  for (const line of lines) {
    const hd = line.match(/^#{1,6}\s+(.*)$/)
    if (hd !== null) { inSection = /验收|acceptance/i.test(hd[1]!); continue }
    if (!inSection) continue
    const m = line.match(/^\s*[-*+]\s+\[[ xX]\]\s*(.+)$/)
    if (m !== null) out.push(m[1]!.trim())
  }
  return out
}

function firstHeading(body: string): string {
  const m = body.match(/^#\s+(.+)$/m)
  return m !== null ? m[1]!.trim().slice(0, 120) : ''
}
