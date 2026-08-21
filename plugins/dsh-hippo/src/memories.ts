/**
 * 记忆库浏览/搜索：scan 全量分页 + hybridSearch（向量×FTS RRF）。
 * 每次请求开关引擎句柄——设置页浏览频率低，不值得常驻（也避免占用 zvec 文件锁）。
 * @module dsh-hippo/memories
 */

import { openEngine, type MemoryRecord } from 'hippo-skills'
import type { MemoryItem, MemoryPage } from './types.ts'

function toItem(r: MemoryRecord): MemoryItem {
  return {
    id: r.id,
    text: r.text,
    type: r.type,
    project: r.project,
    agent: r.agent,
    createdAt: Math.round((r.created_at ?? 0) * 1000),
    strength: r.strength ?? 1,
  }
}

/**
 * 浏览（q 为空）：按创建时间倒序分页，可按 type/project 过滤。
 * 搜索（q 非空）：hybridSearch 跨全部项目桶 RRF 排序，直接返回 top limit。
 */
export async function listMemories(opts: {
  q?: string
  type?: string
  project?: string
  offset: number
  limit: number
}): Promise<MemoryPage> {
  const limit = Math.min(Math.max(opts.limit, 1), 100)
  const offset = Math.max(opts.offset, 0)
  const opened = openEngine()
  try {
    const all = opened.store.scan().map(([r]) => r as MemoryRecord)
    if (opts.q !== undefined && opts.q.trim() !== '') {
      const q = opts.q.trim()
      const projects = [...new Set(all.map((r) => r.project))]
      const vec = await opened.engine.embedder(q)
      const hits = await opened.store.hybridSearch(q, vec, projects, limit)
      const items = hits.map(([r]) => toItem(r as MemoryRecord))
      return { total: items.length, offset: 0, limit, items }
    }
    let filtered = all
    if (opts.type !== undefined && opts.type !== '') filtered = filtered.filter((r) => r.type === opts.type)
    if (opts.project !== undefined && opts.project !== '') filtered = filtered.filter((r) => r.project === opts.project)
    filtered.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    return {
      total: filtered.length,
      offset,
      limit,
      items: filtered.slice(offset, offset + limit).map(toItem),
    }
  } finally {
    opened.close()
  }
}
