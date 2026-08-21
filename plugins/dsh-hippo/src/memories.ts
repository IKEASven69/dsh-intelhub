/**
 * 记忆库浏览/搜索/管理：scan 全量分页 + hybridSearch（向量×FTS RRF）+
 * H3 的 forget/update 与 AGENTS.md 编译（引擎 compile）。
 * 每次请求开关引擎句柄——设置页浏览频率低，不值得常驻（也避免占用 zvec 文件锁）。
 * @module dsh-hippo/memories
 */

import { existsSync, readFileSync } from 'node:fs'
import { compileTarget, groupMemories, openEngine, renderAgentsMd, type MemoryRecord } from 'hippo-skills'
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

/** H3：删除一条记忆。 */
export async function forgetMemory(id: string): Promise<{ ok: boolean }> {
  if (id === '') throw new Error('id 不能为空')
  const opened = openEngine()
  try {
    return { ok: await opened.engine.forget(id) }
  } finally {
    opened.close()
  }
}

/** H3：修改一条记忆（文本/类型/项目）。 */
export async function updateMemory(id: string, fields: { text?: string; type?: string; project?: string }): Promise<{ status: string }> {
  if (id === '') throw new Error('id 不能为空')
  const opened = openEngine()
  try {
    return await opened.engine.update(id, fields)
  } finally {
    opened.close()
  }
}

export interface CompileOutcome {
  project?: string
  memoryCount: number
  markdown: string
  written?: string[]
}

/**
 * H3：编译 AGENTS.md。dryRun（默认）返回 markdown 预览不落盘；
 * write=true 时按 outPath（或引擎默认相对当前目录）写入，合并进既有文件的
 * 标记区块而不是覆盖整文件。
 */
export function compileMemories(opts: { project?: string; write?: boolean; outPath?: string }): CompileOutcome {
  const opened = openEngine()
  try {
    const records = opened.store.scan().map(([r]) => r as MemoryRecord)
    const groups = groupMemories(records, { project: opts.project })
    const markdown = renderAgentsMd(groups)
    const memoryCount = groups.always.length + groups.onDemand.length
      + [...groups.byProject.values()].reduce((s, l) => s + l.length, 0)
    if (!opts.write) return { project: opts.project, memoryCount, markdown }
    const result = compileTarget('agents-md', records, {
      project: opts.project,
      ...(opts.outPath !== undefined && opts.outPath.trim() !== '' ? { outPath: opts.outPath.trim() } : {}),
    })
    return { project: opts.project, memoryCount, markdown, written: result.files }
  } finally {
    opened.close()
  }
}

/** 编译产物预读：outPath 已存在时返回既有内容头几行（面板提示覆盖范围用）。 */
export function peekFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').slice(0, 200)
  } catch {
    return existsSync(path) ? '' : null
  }
}
