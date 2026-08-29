/**
 * 记忆库浏览/搜索/管理：scan 全量分页 + hybridSearch（向量×FTS RRF）+
 * forget/update 与 AGENTS.md 编译（引擎 compile）。
 * G2 起统一走引擎短持（withEngine：引用计数 + 忙等重试）——hippo gui 常开
 * 时本插件照常工作，不再被 zvec 单写锁卡死。
 * @module dsh-hippo/memories
 */

import { existsSync, readFileSync } from 'node:fs'
import { compileTarget, groupMemories, renderAgentsMd, withEngine, type MemoryRecord } from './hippo/engine.js'
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
  return withEngine(async ({ engine, store }) => {
    const all = store.scan().map(([r]) => r as MemoryRecord)
    if (opts.q !== undefined && opts.q.trim() !== '') {
      const q = opts.q.trim()
      const projects = [...new Set(all.map((r) => r.project))]
      const vec = await engine.embedder(q)
      const hits = await store.hybridSearch(q, vec, projects, limit)
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
  })
}

/** H3：删除一条记忆。 */
export async function forgetMemory(id: string): Promise<{ ok: boolean }> {
  if (id === '') throw new Error('id 不能为空')
  return withEngine(async ({ engine }) => ({ ok: await engine.forget(id) }))
}

/** H3：修改一条记忆（文本/类型/项目）。 */
export async function updateMemory(id: string, fields: { text?: string; type?: string; project?: string }): Promise<{ status: string }> {
  if (id === '') throw new Error('id 不能为空')
  return withEngine(async ({ engine }) => engine.update(id, fields))
}

export interface CompileOutcome {
  project?: string
  memoryCount: number
  markdown: string
  written?: string[]
}

/**
 * H3：编译 AGENTS.md。dryRun（默认）返回 markdown 预览不落盘；
 * write=true 时按 outPath（或引擎默认路径）写入，合并进既有文件的标记区块
 * 而不是覆盖整文件。
 */
export async function compileMemories(opts: { project?: string; write?: boolean; outPath?: string }): Promise<CompileOutcome> {
  return withEngine(async ({ store }) => {
    const records = store.scan().map(([r]) => r as MemoryRecord)
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
  })
}

/** 编译产物预读：outPath 已存在时返回既有内容头几行（面板提示覆盖范围用）。 */
export function peekFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').slice(0, 200)
  } catch {
    return existsSync(path) ? '' : null
  }
}
