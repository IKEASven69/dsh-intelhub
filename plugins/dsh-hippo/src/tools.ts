/**
 * H2/H4 的模型工具与提示注入。
 * - memory_recall：检索迁移来的项目记忆（自动按当前 workspaceRoot 归项目过滤）
 * - memory_remember：会话中显式沉淀一条记忆（H4 回写入口，config 门控默认关）
 * - systemPrompt.context：告知工具有效 + 当前项目 pinned 高置信记忆 ≤3 条（<200 token）
 * 工作区解析沿用 dsh-depsec 验证过的 sandboxPolicy + agents 模式。
 * @module dsh-hippo/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context merges（tools/agents/sandboxPolicy/systemPrompt 服务声明）。
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { cwdToProject, openEngine, withEngine } from 'hippo-mind'

/** 渲染：execute 返回字符串，render 包成 text block（dsh-polymarket 先例）。 */
export function renderText(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: String(value) }]
}

interface WorkspaceResolver {
  currentRoot(): string | undefined
  rootOfAgent(agent: Agent | undefined): string | undefined
}

/** depsec 模式：agent.session → sandboxPolicy.resolve；无会话回退全局根。 */
export function makeResolver(ctx: Context): WorkspaceResolver {
  return {
    currentRoot(): string | undefined {
      try {
        const agent = ctx.agents?.currentInitiator()
        if (agent?.session !== undefined) return ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot
        return ctx.sandboxPolicy.workspaceRoot
      } catch {
        return undefined
      }
    },
    rootOfAgent(agent: Agent | undefined): string | undefined {
      try {
        if (agent?.session !== undefined) return ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot
        return this.currentRoot()
      } catch {
        return undefined
      }
    },
  }
}

function fmtDate(sec: number): string {
  if (sec <= 0) return '未知时间'
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** H2：记忆检索工具。 */
export function registerRecallTool(ctx: Context): void {
  const resolver = makeResolver(ctx)
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: '检索跨 agent 迁移来的项目长期记忆（偏好/决策/教训/事实）。回答"这个项目以前怎么定的/踩过什么坑"类问题前先查它。',
    parameters: {
      q: { type: 'string', required: true, description: '检索问题或关键词，如 "状态管理用什么" 或 "构建踩坑"' },
      limit: { type: 'integer', description: '返回条数上限（默认 5）' },
      project: { type: 'string', description: '可选：覆盖项目过滤（默认自动取当前工作区项目名）' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: { q?: string; limit?: number; project?: string }, exec: { agent?: Agent }) {
      const q = (args.q ?? '').trim()
      if (q === '') return 'memory_recall: q 不能为空'
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 20)
      const root = resolver.rootOfAgent(exec?.agent)
      const project = args.project?.trim() !== '' && args.project !== undefined
        ? args.project.trim()
        : root !== undefined ? cwdToProject(root) : 'global'

      return withEngine(async ({ engine, store }) => {
        const vec = await engine.embedder(q)
        const hits = await store.hybridSearch(q, vec, [project, 'global'], limit)
        if (hits.length === 0) return `memory_recall: 项目「${project}」没有匹配的记忆（可换关键词，或该记忆尚未迁移——设置页「记忆桥」可导入会话史）。`
        const lines = hits.map(([r, sim]) => {
          const rec = r as { text: string; type: string; agent: string; created_at: number; source_id: string; project: string }
          const src = rec.agent.replace(/^import:/, '') || '未知来源'
          return `- [${rec.type}]（相关度 ${(sim * 100).toFixed(0)}%，来源 ${src}，${fmtDate(rec.created_at ?? 0)}）${rec.text}`
        })
        return `项目「${project}」的记忆命中 ${hits.length} 条：\n${lines.join('\n')}`
      })
    },
  })), 'dsh-hippo: memory_recall')
}

/** H4：会话中显式沉淀记忆（默认关，cordis.patch.yml config.writeback 显式开启）。 */
export function registerRememberTool(ctx: Context): void {
  const resolver = makeResolver(ctx)
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: '把本会话中有长期价值的项目事实/偏好/决策/教训写入记忆库（跨会话、跨 agent 生效）。仅在被明确要求"记住"时使用。',
    parameters: {
      text: { type: 'string', required: true, description: '自包含的一条记忆，如 "本项目状态管理用 Zustand，不用 Redux"' },
      type: { type: 'string', description: 'preference（偏好）/ decision（决策）/ lesson（教训）/ fact（事实），默认 fact' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: { text?: string; type?: string }, exec: { agent?: Agent }) {
      const text = (args.text ?? '').trim()
      if (text === '') return 'memory_remember: text 不能为空'
      const type = args.type === 'preference' || args.type === 'decision' || args.type === 'lesson' ? args.type : 'fact'
      const root = resolver.rootOfAgent(exec?.agent)
      const project = root !== undefined ? cwdToProject(root) : 'global'

      return withEngine(async ({ engine }) => {
        const r = await engine.remember(text, { type, project, agent: 'dsh:session' })
        return r.status === 'created'
          ? `已记住（${type} · 项目 ${project}）：${text}`
          : `与已有记忆重复（${r.status}），已强化而非新建：${text}`
      })
    },
  })), 'dsh-hippo: memory_remember')
}

/**
 * H2：提示注入——工具有效性说明 + 当前项目 pinned 高置信记忆 ≤3 条。
 * 同步 provider（每次 prompt 组装求值）：strength 排序不需要嵌入，scan 全同步；
 * 任何异常吞掉返回空串，绝不阻断 prompt 组装。
 */
export function registerPromptContext(ctx: Context): void {
  ctx.systemPrompt.context({
    name: 'hippo:memories',
    order: 150,
    text: (): string => {
      try {
        const root = makeResolver(ctx).currentRoot()
        const project = root !== undefined ? cwdToProject(root) : undefined
        const opened = openEngine()
        try {
          const records = opened.store.scan()
            .map(([r]) => r as { text: string; type: string; project: string; strength: number })
            .filter((r) => project !== undefined && r.project === project && r.strength >= 2)
            .sort((a, b) => b.strength - a.strength)
            .slice(0, 3)
          if (records.length === 0) return ''
          const lines = records.map((r) => `- [${r.type}] ${r.text.slice(0, 80)}`).join('\n')
          return `[记忆桥] 可用 memory_recall 工具检索本项目的跨 agent 历史记忆（偏好/决策/教训/事实）。当前项目「${project}」高置信记忆：\n${lines}`
        } finally {
          opened.close()
        }
      } catch {
        return ''
      }
    },
  })
}
