/**
 * 会话导出（G1 提取会话动作）：Markdown 给人读，JSON 给机器/再导入。
 * MD=元数据头+按角色分节的 Turn 流；JSON={version, session, turns}，version 留演进。
 */
import { createHash } from 'node:crypto'
import type { Turn } from '../patterns/transcript.js'
import type { IndexedSession } from './session-index.js'

const ROLE_LABEL: Record<Turn['role'], string> = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
}

function metaOf(session: IndexedSession) {
  return {
    agent: session.agent,
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    project: session.project,
    updatedAt: new Date(session.updatedAt).toISOString(),
    turnCount: session.turnCount,
  }
}

/** 机读格式：版本字段在最外层，后续格式演进靠它区分。 */
export function renderSessionJson(session: IndexedSession, turns: Turn[]): string {
  return JSON.stringify(
    { version: 1, exportedAt: new Date().toISOString(), session: metaOf(session), turns },
    null,
    2,
  ) + '\n'
}

/** 人读格式：元数据表头 + 每条 Turn 一节（工具调用进代码块、失败标注）。 */
export function renderSessionMarkdown(session: IndexedSession, turns: Turn[]): string {
  const m = metaOf(session)
  const lines: string[] = [
    `# ${m.title}`,
    '',
    '| 字段 | 值 |',
    '|---|---|',
    `| agent | ${m.agent} |`,
    `| 项目 | ${m.project} |`,
    `| 工作目录 | \`${m.cwd || '-'}\` |`,
    `| 更新时间 | ${m.updatedAt} |`,
    `| Turn 数 | ${turns.length} |`,
    '',
    '---',
    '',
  ]
  turns.forEach((t, i) => {
    const ts = t.ts ? ` · ${t.ts}` : ''
    const toolTag = t.role === 'tool' ? ` · ${t.toolName || 'tool'}${t.toolFailed ? ' ⚠️ 失败' : ''}` : ''
    lines.push(`### #${i + 1} · ${ROLE_LABEL[t.role]}${toolTag}${ts}`)
    lines.push('')
    if (t.role === 'tool') {
      lines.push('```')
      lines.push(t.text === '' ? '(无输出)' : t.text)
      lines.push('```')
    } else {
      lines.push(t.text)
    }
    lines.push('')
  })
  return lines.join('\n')
}

/** 导出文件名主干：<agent>-<标题或id哈希>，剥掉文件系统非法字符并限长。 */
export function safeFileStem(session: IndexedSession): string {
  const hash = createHash('sha1').update(session.id).digest('hex').slice(0, 8)
  const raw = (session.title && session.title !== session.id ? session.title : session.project) || 'session'
  const cleaned = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60)
  return `${session.agent}-${cleaned || 'session'}-${hash}`
}
