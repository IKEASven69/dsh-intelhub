/**
 * dsh LLM 调用统一层：生活流（居民生成）与蒸馏精炼共用。
 *
 * 走 dsh 的 llm 服务（ctx.llm.prepareCall → stream）——模型路由、凭证、
 * 适配器全部尊重 dsh 配置（settings.yaml 的 agent-default-model 节），
 * 用户在 dsh 里切默认模型，插件行为自动跟随。
 *
 * 历史包袱：此前直连 ollama（127.0.0.1:11434）绕开了 dsh 适配器层——
 * 那是因为早期 ctx.llm 调用方式不对（stream 的 call-config 字段必须与
 * prepareCall 返回的 prepared.config 完全一致，否则 INVALID_PREPARED_CALL，
 * 即当初的 "config changed before adapter dispatch"）。本层用
 * `{ ...prepared.config, ... }` 组装请求，根治该问题。
 *
 * 降级链：ctx.llm（dsh 配的模型）→ 直连 ollama（无 dsh llm 服务的场景，
 * 如独立 CLI 环境）→ 抛错。
 */
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'

const req = createRequire(import.meta.url)

export interface LlmRoute { provider: string; model: string }

/** 读 dsh 默认模型（~/.dsh/settings.yaml 的 agent-default-model 节）。 */
export function readDefaultModel(): LlmRoute | null {
  try {
    const { readFileSync } = req('node:fs') as typeof import('node:fs')
    const { join } = req('node:path') as typeof import('node:path')
    const { homedir } = req('node:os') as typeof import('node:os')
    const yaml = readFileSync(join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
    const start = yaml.indexOf('agent-default-model:')
    if (start === -1) return null
    const section = yaml.slice(start, yaml.indexOf('\n\n', start) === -1 ? undefined : yaml.indexOf('\n\n', start))
    const provider = section.match(/^\s+provider:\s*(\S+)/m)?.[1]
    const model = section.match(/^\s+model:\s*(\S+)/m)?.[1]
    return provider && model ? { provider, model } : null
  } catch {
    return null
  }
}

/**
 * 通过 ctx.llm 生成一次回复（非流式收集 text-delta）。
 * @throws dsh llm 服务不可用 / 无适配器 / 流失败时抛错（调用方决定降级）
 */
export async function dshLlmComplete(ctx: Context, system: string, user: string, opts: { timeoutMs?: number; temperature?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const route = readDefaultModel()
  if (route === null) throw new Error('settings.yaml 无 agent-default-model 节')
  if (typeof ctx?.llm?.prepareCall !== 'function') throw new Error('dsh llm 服务不可用')

  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  // 关键：maxTokens/temperature 属于 LlmCallConfig——必须在 prepareCall 里给出，
  // stream 请求的 call-config 字段与 prepared.config 完全一致，否则 INVALID_PREPARED_CALL
  // （即历史上的 "config changed before adapter dispatch"）。
  const callConfig = {
    provider: route.provider,
    model: route.model,
    maxTokens: 8192, // 思考模型（M3）think 块吃预算，判决 JSON 需要余量
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  }
  const prepared = await ctx.llm.prepareCall(callConfig)
  let out = ''
  let failure: string | null = null
  for await (const chunk of prepared.stream({
    ...prepared.config,
    system,
    messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } })],
    signal: AbortSignal.timeout(timeoutMs),
  })) {
    if (chunk.type === 'text-delta') out += chunk.text
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      failure = `${chunk.reason.kind}: ${JSON.stringify((chunk.reason as { failure?: { message?: string } }).failure?.message ?? '')}`
    }
  }
  if (out === '' && failure !== null) throw new Error(`dsh llm 流失败 ${failure}`)
  return out
}

/** 直连 ollama 兜底（无 dsh llm 服务时；模型取 llm-pi-ai 节，默认 gemma4:e4b）。 */
export async function ollamaComplete(system: string, user: string, opts: { timeoutMs?: number; temperature?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  // 默认模型跟 agent-default-model 走（通常是 gemma4）；绝不能取 llm-pi-ai 的
  // 第一个模型 id——那是 qwen3.5 思考模型，正文输出在 reasoning 通道、content 为空。
  let model = readDefaultModel()?.model ?? 'gemma4:e4b'
  const resp = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 4096,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) {
    throw new Error(`ollama ${resp.status}: ${await resp.text().catch(() => '')}`.slice(0, 200))
  }
  // 思考模型（qwen3.5 等）正文可能输出在 reasoning 通道、content 为空——兜底
  const d = (await resp.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }
  const msg = d.choices?.[0]?.message
  return msg?.content?.trim() !== '' ? msg!.content! : (msg?.reasoning_content ?? '')
}

/**
 * 统一入口：dsh llm 优先，失败降级直连 ollama。
 * 返回 [文本, 使用的通道]；两路全挂时抛最后一次的错误。
 */
export async function llmCompleteWithFallback(ctx: Context, system: string, user: string, opts: { timeoutMs?: number; temperature?: number } = {}): Promise<{ text: string; via: 'dsh-llm' | 'ollama' }> {
  let dshErr = ''
  try {
    const text = await dshLlmComplete(ctx, system, user, opts)
    if (text.trim() !== '') return { text, via: 'dsh-llm' }
    dshErr = 'empty-stream'
  } catch (e) { dshErr = (e as Error).message?.slice(0, 80) ?? 'throw' }
  try {
    const text = await ollamaComplete(system, user, opts)
    if (text.trim() !== '') return { text, via: 'ollama' }
    auditBridge(`via=ollama dsh=[${dshErr}] ollama=empty`)
    return { text, via: 'ollama' }
  } catch (e) {
    auditBridge(`via=none dsh=[${dshErr}] ollama=[${(e as Error).message?.slice(0, 80)}]`)
    throw e
  }
}

/** 桥接审计（与 refine.ts 的 llm-refine.log 同目录，dsh 宿主吞 console 故落文件）。 */
function auditBridge(line: string): void {
  try {
    const { appendFileSync, mkdirSync } = req('node:fs') as typeof import('node:fs')
    const { join } = req('node:path') as typeof import('node:path')
    const { homedir } = req('node:os') as typeof import('node:os')
    const dir = process.env.HIPPO_DATA_DIR ?? join(homedir(), '.hippo')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'llm-refine.log'), `${new Date().toISOString()} BRIDGE ${line}
`)
  } catch { /* 审计失败不影响主流程 */ }
}
