/**
 * 居民的工作感知（操作性上下文注入）。
 *
 * 把 hippo 的任务状态（~/.hippo/tasks.json，TodoWrite 提取）压缩成
 * 200 token 内的"主人近况"摘要，注入居民系统提示。设计依据调研
 * （Adamczyk & Bailey 断点理论 / Inner Thoughts CHI'25 / dsh 生态
 * whale-on-desk 事件门控模式）：
 *
 *  - 直接给事实，不给查询工具——本地小模型在主动发言时刻调工具
 *    最易翻车；细节工具只该存在于用户主动召唤的路径（本模块不提供）。
 *  - 相关性门控：只注入最近活跃的项目任务——居民"看不见"没被激活
 *    的任务清单，结构上杜绝项目经理式罗列。
 *  - 摘要带"截至 HH:MM"时间戳，防止居民把陈旧状态当现在时陈述。
 *  - 附行为约束一行：自然提及可以，主动罗列不行。
 *
 * loadTasks 是旁挂 JSON 读取，不经过 zvec 引擎——零锁开销，K3 每分钟
 * 调用也无压力。
 */
import { loadTasks, type TaskRecord } from 'hippo-mind'

/** 项目在多少天内有任务更新算"活跃"。与引擎 project-card 的 7 天阈值一致。 */
const ACTIVE_DAYS = 7
/** 摘要里最多呈现的项目数与每项目任务条数。 */
const MAX_PROJECTS = 2
const MAX_TASKS_PER_PROJECT = 3
/** K3 注入门槛：用户最近 N 小时内任务有动静，工作话题才值得提。 */
const RECENT_ACTIVITY_MS = 2 * 3600 * 1000

interface ProjectSummary {
  project: string
  updatedAt: number
  openTasks: TaskRecord[]
  total: number
  done: number
}

function summarizeByProject(tasks: TaskRecord[]): ProjectSummary[] {
  const by = new Map<string, ProjectSummary>()
  const now = Date.now()
  for (const t of tasks) {
    const s = by.get(t.project) ?? { project: t.project, updatedAt: 0, openTasks: [], total: 0, done: 0 }
    s.total += 1
    if (t.status === 'completed') s.done += 1
    else s.openTasks.push(t)
    if (t.updatedAt * 1000 > s.updatedAt) s.updatedAt = t.updatedAt * 1000
    by.set(t.project, s)
  }
  const activeCutoff = now - ACTIVE_DAYS * 24 * 3600 * 1000
  return [...by.values()]
    // 活跃项目优先（7 天内有任务动静），再按最近更新排序
    .sort((a, b) => {
      const aa = a.updatedAt >= activeCutoff ? 1 : 0
      const bb = b.updatedAt >= activeCutoff ? 1 : 0
      return bb - aa || b.updatedAt - a.updatedAt
    })
}

function fmtTask(t: TaskRecord): string {
  const mark = t.status === 'in_progress' ? '→' : '·'
  return `${mark}${t.text.slice(0, 40)}`
}

/**
 * 生成"主人近况"摘要（≤200 token）。返回空串 = 没有值得注入的状态。
 *
 * @param opts.project 指定项目（summon/task 路径可传）；缺省取最活跃项目
 * @param opts.onlyIfRecent 严格模式（K3 用）：仅当最近 2h 有任务活动才返回内容，
 *   否则返回空串——用户不在干活时，居民不该聊工作
 */
export function workDigest(opts: { project?: string; onlyIfRecent?: boolean } = {}): string {
  const tasks = loadTasks()
  if (tasks.length === 0) return ''

  const now = Date.now()
  if (opts.onlyIfRecent) {
    const latest = Math.max(...tasks.map(t => t.updatedAt * 1000))
    if (now - latest > RECENT_ACTIVITY_MS) return ''
  }

  let summaries = summarizeByProject(tasks)
  if (opts.project !== undefined && opts.project !== '') {
    summaries = summaries.filter(s => s.project === opts.project)
  }
  const picked = summaries.slice(0, MAX_PROJECTS)
  if (picked.length === 0) return ''

  const asOf = new Date(now)
  const hhmm = `${String(asOf.getHours()).padStart(2, '0')}:${String(asOf.getMinutes()).padStart(2, '0')}`
  const lines: string[] = [`--- 主人近况（截至 ${hhmm}）---`]
  for (const s of picked) {
    const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0
    lines.push(`项目 ${s.project}：${s.done}/${s.total} 完成（${pct}%）`)
    for (const t of s.openTasks
      .sort((a, b) => (a.status === b.status ? b.updatedAt - a.updatedAt : a.status === 'in_progress' ? -1 : 1))
      .slice(0, MAX_TASKS_PER_PROJECT)) {
      lines.push(`  ${fmtTask(t)}`)
    }
  }
  lines.push('（自然聊到时可提一句，别像项目经理一样罗列任务）')
  return lines.join('\n')
}
