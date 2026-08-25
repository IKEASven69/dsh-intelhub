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
  getResident, listResidents, createResident, createChannel,
  appendMessage, readMessages, readBookmark, writeBookmark,
  withEngine, makeTurn, extractCandidates,
} from 'hippo-mind'
import { makeResolver, renderText } from './tools.ts'

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

/** K2：对话后蒸馏入引擎（居民记住这次聊了什么）。 */
async function distillExchange(name: string, userText: string, reply: string): Promise<void> {
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
    }, 5000)
  } catch {
    // 蒸馏失败不阻塞对话——下次对话时重新蒸馏由频道账本兜底
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

  // LLM 生成回复
  const llm = (ctx as Context & { llm?: { generate: (opts: Record<string, unknown>) => Promise<{ text?: string }> } }).llm
  if (llm === undefined || typeof llm.generate !== 'function') {
    return `[${name}] （LLM 服务不可用——确认 dsh 环境）${channelContext !== '' ? '\n' + channelContext : ''}`
  }

  try {
    const result = await llm.generate({
      messages: [
        { role: 'system', content: residentSystemPrompt(name, resident.persona) + channelContext + memoryContext },
        { role: 'user', content: userText },
      ],
    })
    const reply = typeof result.text === 'string' && result.text !== '' ? result.text : '……'
    // 记入频道账本（居民生活继续）
    if (channelId !== undefined) {
      appendMessage(channelId, { kind: 'resident', name }, `[被召唤] ${reply}`)
      writeBookmark(channelId, name, readMessages(channelId, 0, 1)[0]?.seq ?? 0)
    }
    // K2：蒸馏入引擎（异步不阻塞——居民记住这次聊了什么）
    void distillExchange(name, userText, reply)
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

  // 居民协作：让频道内居民接力对话（引擎选下一个人+上下文，这边调 LLM 生成）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'relay_residents',
    description: '让频道内的居民们接力对话（多居民协作讨论）。引擎自动轮转选下一个居民，把频道近况注入上下文，LLM 生成回复。用户说"让他们聊聊/讨论一下"时调用。',
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

      for (let i = 0; i < rounds; i++) {
        const resp = await fetch(`http://127.0.0.1:8139/api/life/channels/${channelId}/relay/next`, { method: 'POST' })
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: resp.statusText }))
          results.push(`[接力失败] ${(err as { error?: string }).error}`)
          break
        }
        const relay = await resp.json() as {
          next: { name: string; persona: string }
          context: Array<{ author: string; kind: string; text: string }>
          channelTopic: string
        }
        const contextText = relay.context.length > 0
          ? '\n\n--- 频道近况 ---\n' + relay.context.map(m => `${m.author}(${m.kind}): ${m.text}`).join('\n')
          : ''
        const systemPrompt = `${relay.next.persona}\n\n你是「${relay.next.name}」，住在 hippo 频道「${relay.channelTopic}」里。频道里还有其他居民，你们在协作讨论。用你的语气说话（1-3 句），可以对其他居民的话回应或补充。` + contextText
        const userPrompt = (args.topic ?? '').trim() !== '' ? args.topic.trim() : '继续频道讨论（对最近的消息做出回应）'

        const llm = (ctx as Context & { llm?: { generate: (opts: Record<string, unknown>) => Promise<{ text?: string }> } }).llm
        if (llm === undefined) { results.push(`[${relay.next.name}] （LLM 服务不可用）`); break }

        try {
          const result = await llm.generate({ messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ] })
          const reply = typeof result.text === 'string' && result.text !== '' ? result.text : '……'
          const { appendMessage } = await import('hippo-mind')
          appendMessage(channelId, { kind: 'resident', name: relay.next.name }, reply)
          results.push(`[${relay.next.name}] ${reply}`)
        } catch (e) {
          results.push(`[${relay.next.name}] （生成失败：${e instanceof Error ? e.message : String(e)}）`)
          break
        }
      }
      return results.join('\n')
    },
  }), 'dsh-hippo: relay_residents')
}
