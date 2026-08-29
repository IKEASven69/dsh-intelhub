/**
 * 生活流工具（K1）：summon_resident（@召唤居民进入对话）、
 * create_resident / list_residents（对话内管理居民）。
 * 召唤 = 引擎 store 读 persona + 频道游标内近况 → ctx.llm 生成回复 →
 * 回复返回 dsh 会话 + 同步记入频道账本（居民的生活在继续）。
 * @module dsh-hippo/life-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {
  getResident, listResidents, createResident, createChannel, getChannel,
  appendMessage, readMessages, readBookmark, writeBookmark,
  withEngine, makeTurn, extractCandidates,
} from './hippo/engine.js'
import { makeResolver, renderText } from './tools.ts'
import { workDigest } from './project-awareness.ts'


/** 生活流 LLM 入口：走 dsh 配的模型（ctx.llm），无 dsh llm 服务时降级直连 ollama。
 * summon/relay/task/K3 点醒共用这一条路径——模型路由尊重 dsh 的
 * agent-default-model 配置，用户在 dsh 里切模型插件自动跟随。 */
export async function llmComplete(
  ctx: Context,
  system: string,
  user: string,
): Promise<string> {
  const { llmCompleteWithFallback } = await import('./dsh-llm.ts')
  const { text } = await llmCompleteWithFallback(ctx, system, user)
  return text
}

/** 居民记忆 scope（引擎 project 机制）。 */
const memoryScope = (name: string): string => `life:${name}`

/** K2：召回与当前话题相关的居民记忆（Top-3，注入系统提示）。 */
export async function recallMemories(name: string, query: string): Promise<string> {
  try {
    return await withEngine(async ({ engine }) => {
      const hits = await engine.recall(query, { project: memoryScope(name), limit: 3 })
      if (hits.length === 0) return ''
      return '\n\n--- 你的相关记忆（之前对话沉淀的）---\n' + hits.map((h) => `· ${h.text.slice(0, 120)}`).join('\n')
    }, 5000) // 记忆召回失败不阻塞对话
  } catch {
    return ''
  }
}

/** K2：对话后蒸馏入引擎（居民记住这次聊了什么）。
 * 超时 60s：engine.remember 要跑 bge-m3 嵌入，首次加载模型就要十几秒，
 * 之前的 5s 在冷启动环境必超时——蒸馏静默丢弃，居民永远"记不住"。 */
async function distillExchange(ctx: Context, name: string, userText: string, reply: string): Promise<void> {
  try {
    await withEngine(async ({ engine }) => {
      const turns = [
        makeTurn({ role: 'user', text: userText }),
        makeTurn({ role: 'assistant', text: `[${name}] ${reply}` }),
      ]
      const candidates = extractCandidates(turns).slice(0, 5)
      for (const c of candidates) {
        if (c.duplicate === 'reinforce' || c.duplicate === 'maybe') continue
        await engine.remember(c.text, {
          type: c.type === 'preference' ? 'decision' : c.type,
          project: memoryScope(name),
          agent: 'life',
        })
      }
    }, 60_000)
  } catch (e) {
    // 蒸馏失败不阻塞对话（频道账本兜底），但要有日志——静默丢记忆没法排查
    ctx.logger.warn(`[life] ${name} 蒸馏失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 组装居民的系统提示：persona + 身份 + 行为约束。 */
function residentSystemPrompt(name: string, persona: string): string {
  return `${persona}\n\n你是「${name}」，一位住在 hippo 生活流的居民。你被用户召唤进当前对话。保持你的人格：用你的语气说话，不要出戏。回复简洁自然（1-3 句），像一个真实的存在。`
}

/** 召唤居民：生成回复并记入频道账本。 */
export async function summonResident(
  ctx: Context,
  name: string,
  userText: string,
  agent?: Agent,
): Promise<string> {
  const resident = getResident(name)
  if (resident === null) {
    const all = listResidents().map((r) => r.name).join('、')
    return `居民「${name}」不存在。${all !== '' ? `现有居民：${all}。` : '还没有居民——用 create_resident 创建一位。'}`
  }

  // 频道近况：居民的第一个活跃频道（游标后未读消息）
  let channelContext = ''
  const channelId = resident.state.channels[0]
  if (channelId !== undefined) {
    const cursor = readBookmark(channelId, name)
    const recent = readMessages(channelId, cursor, 10)
    if (recent.length > 0) {
      channelContext = '\n\n--- 频道近况（你未读的）---\n' + recent.map((m) => `${(m.author as { name: string }).name}: ${m.text.slice(0, 120)}`).join('\n')
    }
  }

  // K2：记忆召回（与当前话题相关的之前对话）
  const memoryContext = await recallMemories(name, userText)
  // 工作感知：主人最近在忙什么（用户主动召唤——值得注入近况）
  const work = workDigest()

  try {
    const reply = await llmComplete(ctx, residentSystemPrompt(name, resident.persona) + channelContext + memoryContext + (work !== '' ? '\n\n' + work : ''), userText) || '……'
    // 记入频道账本（居民生活继续）。appendMessage 返回值带最新 seq，
    // 书签直接用它——之前误写 readMessages(0,1)[0]?.seq 把游标设回了
    // 频道第一条，导致每次召唤后"未读"变成全部历史。
    if (channelId !== undefined) {
      const msg = appendMessage(channelId, { kind: 'resident', name }, `[被召唤] ${reply}`)
      writeBookmark(channelId, name, msg.seq)
    }
    // K2：蒸馏入引擎（异步不阻塞——居民记住这次聊了什么）
    void distillExchange(ctx, name, userText, reply)
    return `[${name}] ${reply}`
  } catch (e) {
    return `[${name}] （生成失败：${e instanceof Error ? e.message : String(e)}）`
  }
}

/** 注册生活流工具组。 */
export function registerLifeTools(ctx: Context): void {
  const resolver = makeResolver(ctx)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'summon_resident',
    description: '召唤一位生活流居民进入当前对话（用户 @名字 或明确要求找某人时调用）。居民有人格和记忆，以它的身份回复。',
    parameters: {
      name: { type: 'string', required: true, description: '居民名（kebab-case，如 moli）' },
      message: { type: 'string', required: true, description: '要对居民说的话/问的问题' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: { name?: string; message?: string }, exec: { agent?: Agent }) {
      const name = (args.name ?? '').trim()
      const msg = (args.message ?? '').trim()
      if (name === '' || msg === '') return 'name 和 message 不能为空'
      void resolver
      return await summonResident(ctx, name, msg, exec?.agent)
    },
  })), 'dsh-hippo: summon_resident')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_residents',
    description: '列出全部生活流居民（名字/人格摘要/活跃频道）。用户问"有哪些居民"时调用。',
    parameters: {},
    output: { schema: { type: 'string' }, render: renderText },
    async execute() {
      const all = listResidents()
      if (all.length === 0) return '还没有居民。用 create_resident 创建。'
      return all.map((r) => `· ${r.name}（${r.state.channels.length} 频道，话痨 ${r.state.chattiness}/h）：${r.persona.slice(0, 60)}${r.persona.length > 60 ? '…' : ''}`).join('\n')
    },
  })), 'dsh-hippo: list_residents')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'create_resident',
    description: '创建一位生活流居民（用户要求"建一个 XX 性格的居民"时调用）。',
    parameters: {
      name: { type: 'string', required: true, description: 'kebab-case 名字（如 moli / chef / critic）' },
      persona: { type: 'string', required: true, description: '人格设定：性格/说话方式/关注什么（2-5 句）' },
      channel: { type: 'string', description: '可选：加入的频道 id（不存在则自动创建为通用频道）' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: { name?: string; persona?: string; channel?: string }) {
      const name = (args.name ?? '').trim()
      const persona = (args.persona ?? '').trim()
      if (name === '' || persona === '') return 'name 和 persona 不能为空'
      try {
        const r = createResident(name, persona)
        let chNote = ''
        if (args.channel !== undefined && args.channel.trim() !== '') {
          const chId = args.channel.trim()
          try { createChannel(chId, `${name} 的频道`, [name]); chNote = `，已加入频道 #${chId}` }
          catch { chNote = `（频道 #${chId} 已存在）` }
        }
        return `居民「${r.name}」已创建${chNote}。人格：${persona.slice(0, 60)}…\n现在可以 @${r.name} 或用 summon_resident 召唤。`
      } catch (e) {
        return `创建失败：${e instanceof Error ? e.message : String(e)}`
      }
    },
  })), 'dsh-hippo: create_resident')

  // 居民协作：让频道内居民接力对话（直接调 hippo-mind 库，不走 HTTP）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'relay_residents',
    description: '让频道内的居民们接力对话（多居民协作讨论）。自动轮转选下一个居民，把频道近况注入上下文，LLM 生成回复。用户说"让他们聊聊/讨论一下"时调用。',
    parameters: {
      channel: { type: 'string', required: true, description: '频道 id' },
      topic: { type: 'string', description: '本轮话题提示（可选，默认延续最近对话）' },
      rounds: { type: 'number', description: '接力轮数，1-5（默认 1）' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: { channel?: string; topic?: string; rounds?: number }) {
      const channelId = (args.channel ?? '').trim()
      if (channelId === '') return 'channel 不能为空'
      const rounds = Math.min(Math.max(1, Number(args.rounds) || 1), 5)
      const results: string[] = []

      const { getChannel } = await import('./hippo/engine.js')

      for (let i = 0; i < rounds; i++) {
        const ch = getChannel(channelId)
        if (ch === null) { results.push(`[接力失败] 频道「${channelId}」不存在`); break }
        const members = ch.members.filter(m => m !== 'user')
        if (members.length < 2) { results.push('[接力失败] 至少需要 2 个居民'); break }

        // 轮转：最后说话的居民 → 下一个
        const msgs = readMessages(channelId, 0, 50)
        const lastResident = [...msgs].reverse().find(m => m.author.kind === 'resident')
        const lastIdx = lastResident ? members.indexOf((lastResident.author as { name: string }).name) : -1
        const nextName = members[(lastIdx + 1) % members.length]
        const resident = getResident(nextName)
        if (resident === null) { results.push(`[接力失败] 居民「${nextName}」不存在`); break }

        const contextText = msgs.length > 0
          ? '\n\n--- 频道讨论 ---\n' + msgs.slice(-10).map(m => {
              const author = m.author.kind === 'resident' ? m.author.name : '用户'
              return `${author}: ${m.text.slice(0, 80)}`
            }).join('\n')
          : ''

        const systemPrompt = `${resident.persona}\n\n你是「${nextName}」，在频道「${ch.topic}」里和另一位居民讨论。用你的语气说话（1-3 句中文），可以对对方的话回应或质疑。` + contextText
        const topicText = typeof args.topic === 'string' ? args.topic.trim() : ''
        const userPrompt = topicText !== '' ? topicText : '继续讨论（对最近的消息做出回应）'

        try {
          const reply = await llmComplete(ctx, systemPrompt, userPrompt) || '……'
          appendMessage(channelId, { kind: 'resident', name: nextName }, reply.slice(0, 500))
          results.push(`[${nextName}] ${reply}`)
        } catch (e) {
          results.push(`[${nextName}] （生成失败：${e instanceof Error ? e.message : String(e)}）`)
          break
        }
      }
      return results.join('\n')
    },
  })), 'dsh-hippo: relay_residents')

  // K1.5 居民干活：给居民一个任务 → 召回记忆 → LLM 干活 → 产出+入库
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_resident',
    description: '给一位居民分配工作任务（居民用记忆+人格完成任务并产出结果）。用户说"让 XX 干/做/写/查"时调用。区别于 summon（闲聊）和 relay（多居民讨论），这是单居民产出。',
    parameters: {
      name: { type: 'string', required: true, description: '居民名' },
      task: { type: 'string', required: true, description: '任务描述（要做什么、产出什么）' },
      channel: { type: 'string', description: '可选：结果记入的频道 id' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: { name?: string; task?: string; channel?: string }) {
      const name = (args.name ?? '').trim()
      const task = (args.task ?? '').trim()
      if (name === '' || task === '') return 'name 和 task 不能为空'
      const resident = getResident(name)
      if (resident === null) return `居民「${name}」不存在`

      // 召回相关记忆（与任务相关的项目偏好/坑/决策）
      let memoryContext = ''
      try {
        const { withEngine } = await import('./hippo/engine.js')
        memoryContext = await withEngine(async ({ engine }) => {
          const hits = await engine.recall(task, { project: 'global', limit: 3 })
          return hits.length > 0 ? '\n\n--- 相关记忆 ---\n' + hits.map((h: { type: string; text: string }) => `[${h.type}] ${h.text.slice(0, 100)}`).join('\n') : ''
        }).catch(() => '')
      } catch { /* 引擎不可用不阻断 */ }

      const work = workDigest()
      const systemPrompt = `${resident.persona}

你是「${name}」，接到一项工作任务。用你的专业能力完成它，输出实际结果（不是"我会做"而是做了什么）。` + memoryContext + (work !== '' ? '\n\n' + work : '')
      try {
        const output = await llmComplete(ctx, systemPrompt, task) || '（空产出）'

        // 记入频道（可选）
        const chId = (args.channel ?? '').trim()
        if (chId !== '') {
          const { appendMessage } = await import('./hippo/engine.js')
          appendMessage(chId, { kind: 'resident', name }, `[任务] ${task}
${output}`)
        }

        // K2 蒸馏：任务+产出入库为记忆（"干了什么"）
        try {
          const { withEngine } = await import('./hippo/engine.js')
          void withEngine(async ({ engine }) => {
            await engine.remember(`任务完成（${name}）：${task.slice(0, 80)} → 产出：${output.slice(0, 120)}`, {
              type: 'fact', project: 'life:tasks', agent: 'life',
            })
          }).catch(() => {})
        } catch { /* 尽力 */ }

        return `[${name}] ${output}`
      } catch (e) {
        return `[${name}] （任务失败：${e instanceof Error ? e.message : String(e)}）`
      }
    },
  })), 'dsh-hippo: task_resident')
}
