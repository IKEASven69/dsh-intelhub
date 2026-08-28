/**
 * K3 主动行为 + K4 人格演化。
 *
 * K3：定时点醒（chattiness 参数控频）→ LLM 自主决定发言或沉默
 * （自检：与频道近况重复/无新内容则沉默）→ 发言入账本。
 *
 * K4：人格演化视图（memory-scope）= persona + 高强记忆 compile——
 * "经历塑造性格"。persona.md 永不自动改写（用户主权），演化只发生在
 * 可再生视图；一键回到出厂人格 = 删 memory-scope。
 * @module dsh-hippo/life-autonomy
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import {
  getResident, listResidents, readMessages, readBookmark, writeBookmark, appendMessage,
  withEngine, recallMemories,
} from './life-bridge.ts'
import { llmComplete } from './life-tools.ts'

// ── K4：人格演化视图 ─────────────────────────────────

const LIFE_DIR = join(process.env.HIPPO_DATA_DIR ?? join(homedir(), '.hippo'), 'life')

function residentDir(name: string): string {
  return join(LIFE_DIR, 'residents', name)
}

/**
 * 生成/刷新居民的人格演化视图（memory-scope.md）。
 * = persona 原文 + "--- 经历沉淀 ---" + 高强记忆（strength ≥2 的 Top-10）。
 * 召唤时优先用这个视图（比裸 persona 更"有经历"）；删掉即回出厂。
 */
export async function refreshEvolvedPersona(name: string): Promise<string> {
  const r = getResident(name)
  if (r === null) throw new Error(`居民不存在：${name}`)

  // 召回高强记忆（strength 排序取 Top-10）
  const memories = await withEngine(async ({ store }: { store: { scan: () => Array<[{ text: string; strength: number; project: string; type: string }, number]> } }) => {
    const scope = `life:${name}`
    return store.scan()
      .map(([rec]) => rec)
      .filter((m: { text: string; strength: number; project: string; type: string }) => m.project === scope && m.strength >= 2)
      .sort((a: { strength: number }, b: { strength: number }) => b.strength - a.strength)
      .slice(0, 10)
      .map((m: { type: string; text: string }) => `· [${m.type}] ${m.text.slice(0, 100)}`)
  }, 5000).catch(() => [] as string[])

  const evolved = memories.length > 0
    ? `${r.persona}\n\n--- 经历沉淀（你的记忆塑造了你）---\n${memories.join('\n')}`
    : r.persona

  const dir = residentDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'memory-scope.md'), evolved, 'utf8')
  return evolved
}

/** 读取演化视图（没有则回退 persona 原文 = 出厂状态）。 */
export function getEvolvedPersona(name: string): string {
  const file = join(residentDir(name), 'memory-scope.md')
  if (existsSync(file)) {
    try { return readFileSync(file, 'utf8') } catch { /* 回退 */ }
  }
  const r = getResident(name)
  return r?.persona ?? ''
}

// ── K3：主动行为（点醒循环）──────────────────────────

/** 自检：判断是否值得发言（有新内容且不与近况重复）。 */
function shouldSpeak(recentUnread: string[], draft: string): boolean {
  if (recentUnread.length === 0 && draft.trim() === '') return false
  const text = draft.slice(0, 200)
  if (text.length < 4) return false
  // 重复检测：字符 2-gram 重叠（中文友好——按空格分词对中文无效）
  const grams = new Set<string>()
  for (let i = 0; i < text.length - 1; i++) grams.add(text.slice(i, i + 2))
  if (grams.size < 2) return false
  for (const msg of recentUnread.slice(-3)) {
    const msgText = msg.slice(0, 200)
    const msgGrams = new Set<string>()
    for (let i = 0; i < msgText.length - 1; i++) msgGrams.add(msgText.slice(i, i + 2))
    const overlap = [...grams].filter((g) => msgGrams.has(g)).length / grams.size
    if (overlap > 0.6) return false
  }
  return true
}

/**
 * 点醒一位居民：看频道未读 → 决定说不说 → 说则入账本。
 * 返回发言内容（null=沉默）。
 */
export async function wakeResident(ctx: Context, name: string): Promise<string | null> {
  const r = getResident(name)
  if (r === null) return null

  const channelId = r.state.channels[0]
  if (channelId === undefined) return null // 无频道不主动

  const cursor = readBookmark(channelId, name)
  const unread = readMessages(channelId, cursor, 10)
  const recentTexts = unread.map((m) => m.text)

  const evolved = getEvolvedPersona(name)
  const memoryCtx = await recallMemories(name, unread.length > 0 ? unread[unread.length - 1].text : '日常')

  const systemPrompt = `${evolved}${memoryCtx}

--- 当前状态 ---
你被定时点醒了。${unread.length > 0 ? `频道有 ${unread.length} 条你未读的消息：\n${recentTexts.slice(-5).map((t) => t.slice(0, 100)).join('\n')}` : '频道没有新消息。'}

如果你觉得有值得说的（回应新消息/分享想法/关心某人），请直接说出你想说的话（1-3 句，保持人格）。
如果没什么好说的，只输出"[SILENCE]"。`

  // 统一走 ollama 直连（llmComplete）——此前走 ctx.llm，dsh llm 服务
  // 不可用时 K3 整体静默死亡且无任何日志。
  try {
    const text = (await llmComplete(ctx, systemPrompt, '（点醒）')).trim()
    // 已读即推进游标（沉默也推进）——此前从不写书签，同一批消息
    // 每次点醒都重复算"未读"。
    const readUpTo = unread.length > 0 ? unread[unread.length - 1].seq : cursor
    if (text === '' || text === '[SILENCE]') {
      writeBookmark(channelId, name, readUpTo)
      return null
    }
    if (!shouldSpeak(recentTexts, text)) {
      writeBookmark(channelId, name, readUpTo)
      return null
    }
    const msg = appendMessage(channelId, { kind: 'resident', name }, text)
    // 推进到自己的发言——下次点醒不会把自己的话当未读
    writeBookmark(channelId, name, msg.seq)
    return text
  } catch (e) {
    ctx.logger.warn(`[life] K3 点醒 ${name} 生成失败：${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * 启动主动行为循环（dsh web 常驻时活跃）。
 * 每分钟检查一次：按 chattiness 概率点醒（1/h ≈ 每 60 分钟 1 次）。
 */
export function startAutonomyLoop(ctx: Context): () => void {
  const timer = setInterval(() => {
    // 按概率选中要点醒的居民，然后并行唤醒——此前串行 await，
    // 一个居民的 LLM 慢（最长 120s 超时）会阻塞后面所有居民。
    const toWake = listResidents()
      .filter((r) => r.state.chattiness > 0 && Math.random() <= r.state.chattiness / 60)
      .map((r) => r.name)
    if (toWake.length === 0) return
    void Promise.allSettled(toWake.map(async (name) => {
      const said = await wakeResident(ctx, name)
      if (said !== null) {
        ctx.logger.info(`[life] ${name} 主动发言：${said.slice(0, 40)}`)
        // 主动发言后刷新演化视图（经历更新）
        void refreshEvolvedPersona(name).catch(() => {})
      }
    }))
  }, 60_000)
  timer.unref?.()
  return () => { clearInterval(timer) }
}
