/**
 * 消息台 v1：评论收件箱（手动粘贴/平台通知导入）+ 回复管理。
 * 数据存 deck.json messages[]。纯函数可测。@module dsh-deck/messages
 */

export interface MessageInput {
  platform?: unknown
  author?: unknown
  text?: unknown
  contentSlug?: unknown
}

export function normalizeMessage(input: MessageInput): { ok: true; value: { id: string; platform: string; author: string; text: string; contentSlug: string; time: string; status: 'new'; reply: string } } | { ok: false; error: string } {
  const platform = typeof input.platform === 'string' ? input.platform.trim().slice(0, 20) : ''
  const author = typeof input.author === 'string' ? input.author.trim().slice(0, 40) : ''
  const text = typeof input.text === 'string' ? input.text.trim().slice(0, 2000) : ''
  const slug = typeof input.contentSlug === 'string' ? input.contentSlug.trim().slice(0, 120) : ''
  if (text === '') return { ok: false, error: '评论内容必填' }
  if (platform === '') return { ok: false, error: '平台必填' }
  return {
    ok: true,
    value: {
      id: 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      platform, author: author || '匿名', text, contentSlug: slug,
      time: new Date().toISOString().slice(0, 10),
      status: 'new' as const, reply: '',
    },
  }
}

export function setReply(messages: Array<Record<string, unknown>>, id: string, reply: string): Array<Record<string, unknown>> | null {
  const idx = messages.findIndex((m) => m.id === id)
  if (idx === -1) return null
  const out = messages.slice()
  out[idx] = { ...out[idx]!, reply: reply.slice(0, 2000), status: 'replied', repliedAt: new Date().toISOString().slice(0, 10) }
  return out
}

/** AI 起草回复模板（v1 本地生成，v2 接宿主模型） */
export function draftReply(msg: { platform: string; author: string; text: string }): string {
  const short = msg.text.slice(0, 40)
  const byPlat: Record<string, string> = {
    '微博': `@${msg.author} 感谢关注！关于"${short}"——这个问题很好，我在这篇文章里有详细展开，欢迎看看～有其他想法也随时交流 🙌`,
    'X': `@${msg.author} Thanks for the feedback! Regarding "${short}" — great question. I cover this in detail in the article. Happy to discuss further! 🙌`,
    '知乎': `感谢提问！关于"${short}"，这在原文中有详细分析。简单来说：核心观点是……（建议补充具体内容）。如果还有疑问欢迎继续讨论～`,
  }
  return byPlat[msg.platform] ?? `感谢关注！关于"${short}"——已收到，会认真考虑您的建议。`
}
