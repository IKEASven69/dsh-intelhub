/**
 * dsh-zvec-kb 浏览器半:设置页「本地知识库」。
 * 视觉对齐 OpenCLIApp 冷灰深色 + 蓝强调(#4A9EFF)——与 dsh-opencli 面板同一设计语言。
 * 职责:导入(文件/文件夹)→ 索引进度 → 语义+关键词混合检索预览 → 文件管理。
 * @module dsh-zvec-kb/client
 */

import { createElement, useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { FileEntry, ImportResult, ListResult, RemoveResult, SearchResult, StatusResult } from './types.ts'
// 仅类型面:拉入 settings.section 槽位声明
import type {} from '@deepseek-ai/dsh-client-ui-settings'

export const inject = ['slots']

async function rpc<T>(method: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; value?: T; error?: { message: string } }> {
  try {
    const res = await fetch(`/api/zvecKb/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: (globalThis.crypto?.randomUUID?.() ?? String(Date.now() + Math.random())),
        method: `zvecKb/${method}`,
        payload: { args },
      }),
    })
    const msg = await res.json() as { result?: { ok: boolean; value?: T; error?: { message?: string } } }
    if (msg.result !== undefined && msg.result.ok) return { ok: true, value: msg.result.value }
    return { ok: false, error: { message: msg.result?.error?.message ?? `HTTP ${res.status}` } }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : String(e) } }
  }
}

const CSS = `
.zkb { display: flex; flex-direction: column; gap: 16px; font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; color: #F0F0F2; }
.zkb-head { display: flex; align-items: flex-start; gap: 14px; }
.zkb-icon { flex: none; width: 46px; height: 46px; border-radius: 12px; background: #4A9EFF;
  display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 800; color: #fff; }
.zkb-title { font-size: 20px; font-weight: 700; line-height: 1.35; }
.zkb-desc { font-size: 12.5px; color: #9A9AA0; margin-top: 3px; line-height: 1.55; }
.zkb-btn { flex: none; cursor: pointer; border: none; background: #3A3A3E; color: #F0F0F2;
  border-radius: 8px; padding: 8px 14px; font-size: 12.5px; transition: background .15s; white-space: nowrap; }
.zkb-btn:hover { background: #46464B; }
.zkb-btn:disabled { opacity: .6; cursor: default; }
.zkb-btn-pri { background: #4A9EFF; color: #fff; }
.zkb-btn-pri:hover { background: #3D8EE8; }
.zkb-card { background: #26262A; border: 1px solid rgba(255,255,255,.05); border-radius: 14px; padding: 4px 18px; }
.zkb-srow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 11px 0; border-bottom: 1px solid rgba(255,255,255,.06); font-size: 13px; }
.zkb-srow:last-child { border-bottom: none; }
.zkb-sk { color: #9A9AA0; flex: none; }
.zkb-sv { color: #F0F0F2; }
.zkb-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.zkb-ok { background: #34C759; }
.zkb-bad { background: #FF453A; }
.zkb-mid { background: #9A9AA0; }
.zkb-hint { font-size: 11.5px; color: #9A9AA0; line-height: 1.6; }
.zkb-input { flex: 1; min-width: 120px; background: #1C1C1F; border: 1px solid rgba(255,255,255,.09); color: #F0F0F2;
  border-radius: 8px; padding: 8px 12px; font-size: 13px; outline: none; }
.zkb-input:focus { border-color: #4A9EFF; }
.zkb-files { max-height: 300px; overflow: auto; }
.zkb-frow { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,.06); font-size: 12.5px; }
.zkb-frow:last-child { border-bottom: none; }
.zkb-fpath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; }
.zkb-fmeta { flex: none; color: #9A9AA0; font-size: 11.5px; }
.zkb-hit { padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
.zkb-hit:last-child { border-bottom: none; }
.zkb-hitref { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-size: 12px; color: #4A9EFF; word-break: break-all; }
.zkb-hitscore { color: #9A9AA0; font-size: 11px; margin-left: 8px; }
.zkb-hitsnip { font-size: 12.5px; color: #C9C9CE; margin-top: 5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.zkb-badge { flex: none; border-radius: 5px; padding: 1px 7px; font-size: 11px; background: rgba(74,158,255,.16); color: #4A9EFF; }
.zkb-err { color: #FF6961; font-size: 12px; }
`

function Panel(): ReturnType<typeof createElement> {
  const [status, setStatus] = useState<StatusResult | null>(null)
  const [list, setList] = useState<ListResult | null>(null)
  const [path, setPath] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult | null>(null)
  const [busyImport, setBusyImport] = useState(false)
  const [busySearch, setBusySearch] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    const s = await rpc<StatusResult>('status')
    if (s.ok && s.value !== undefined) setStatus(s.value)
    const l = await rpc<ListResult>('list')
    if (l.ok && l.value !== undefined) setList(l.value)
  }

  useEffect(() => {
    void refresh()
  }, [])

  // 索引中 → 轮询进度
  useEffect(() => {
    if (status === null || status.indexing === 0) return
    const t = window.setInterval(() => { void refresh() }, 1500)
    return () => window.clearInterval(t)
  }, [status?.indexing])

  const doImport = async (): Promise<void> => {
    if (path.trim() === '') return
    setBusyImport(true)
    setErr(null)
    const r = await rpc<ImportResult>('import', { path })
    if (r.ok && r.value !== undefined && r.value.ok) {
      setPath('')
      await refresh()
    } else {
      setErr(r.value?.error ?? r.error?.message ?? '导入失败')
    }
    setBusyImport(false)
  }

  const doSearch = async (): Promise<void> => {
    if (query.trim() === '') return
    setBusySearch(true)
    setErr(null)
    const r = await rpc<SearchResult>('search', { query, topk: 5 })
    if (r.ok && r.value !== undefined) setResults(r.value)
    else setErr(r.error?.message ?? '检索失败')
    setBusySearch(false)
  }

  const doRemove = async (p: string): Promise<void> => {
    const r = await rpc<RemoveResult>('remove', { path: p })
    if (!(r.ok && r.value !== undefined && r.value.ok)) setErr(r.value?.error ?? r.error?.message ?? '删除失败')
    await refresh()
  }

  const modelDot = status?.model === 'ready' ? 'zkb-ok' : status?.model === 'loading' ? 'zkb-mid' : 'zkb-bad'
  const modelText = status?.model === 'ready' ? '就绪(本地 e5-small)' : status?.model === 'loading' ? '加载中…' : '不可用'

  const hitLines = (results?.hits ?? []).map((h, i) => {
    const bar = results !== null && results.hits.length > 0
      ? Math.max(6, Math.round((h.score / results.hits[0].score) * 100)) : 0
    return createElement('div', { className: 'zkb-hit', key: i },
      createElement('div', null,
        createElement('span', { className: 'zkb-hitref' }, h.ref),
        createElement('span', { className: 'zkb-hitscore' }, `相关度 ${bar}%`),
      ),
      createElement('div', { className: 'zkb-hitsnip' }, h.text.length > 260 ? h.text.slice(0, 260) + '…' : h.text),
    )
  })

  return createElement('div', { className: 'zkb' },
    createElement('style', null, CSS),
    // ── 页头 ──
    createElement('div', { className: 'zkb-head' },
      createElement('span', { className: 'zkb-icon' }, 'KB'),
      createElement('div', { style: { minWidth: 0 } },
        createElement('div', { className: 'zkb-title' }, '本地知识库'),
        createElement('div', { className: 'zkb-desc' }, 'zvec 原生·语义+关键词混合检索·零守护进程·零 API key·文档不出本机。把文档(或整个文件夹)交给 agent 检索。'),
      ),
    ),
    err !== null ? createElement('div', { className: 'zkb-err' }, err) : null,
    // ── 状态卡 ──
    createElement('div', { className: 'zkb-card' },
      createElement('div', { className: 'zkb-srow' },
        createElement('span', { className: 'zkb-sk' }, '已导入'),
        createElement('span', { className: 'zkb-sv' }, `${status?.files ?? '–'} 个文件 · ${status?.chunks ?? '–'} 块`),
        status !== null && status.indexing > 0 ? createElement('span', { className: 'zkb-badge' }, `索引中 ${status.indexing}`) : null,
      ),
      createElement('div', { className: 'zkb-srow' },
        createElement('span', { className: 'zkb-sk' }, '检索模型'),
        createElement('span', { className: `zkb-dot ${modelDot}` }),
        createElement('span', { className: 'zkb-sv' }, modelText),
        createElement('span', { className: 'zkb-hint', style: { marginLeft: 'auto' } }, '首次导入时自动下载(约 30MB),全程本机'),
      ),
    ),
    // ── 导入卡 ──
    createElement('div', { className: 'zkb-card' },
      createElement('div', { className: 'zkb-srow' },
        createElement('input', { className: 'zkb-input', placeholder: '文件或文件夹的绝对路径(支持 ~)', value: path, onChange: (e: { target: { value: string } }) => setPath(e.target.value), onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') void doImport() } }),
        createElement('button', { className: 'zkb-btn zkb-btn-pri', disabled: busyImport || path.trim() === '', onClick: () => { void doImport() } }, busyImport ? '导入中…' : '导入'),
      ),
      createElement('div', { className: 'zkb-srow' },
        createElement('span', { className: 'zkb-hint' }, '支持 md / txt / pdf / docx / json / yaml / 代码等。整个文件夹可一次导入:后台建索引,重复导入只处理新增与变更。导入后 agent 经 kb_search 检索,结果带 文件路径#块号 来源。'),
      ),
    ),
    // ── 检索预览卡 ──
    createElement('div', { className: 'zkb-card' },
      createElement('div', { className: 'zkb-srow' },
        createElement('input', { className: 'zkb-input', placeholder: '试试语义检索:换个说法也能找到(如"怎么配置超时时间")', value: query, onChange: (e: { target: { value: string } }) => setQuery(e.target.value), onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') void doSearch() } }),
        createElement('button', { className: 'zkb-btn', disabled: busySearch || query.trim() === '', onClick: () => { void doSearch() } }, busySearch ? '检索中…' : '检索'),
      ),
      results !== null && results.hits.length > 0
        ? createElement('div', { className: 'zkb-srow', style: { display: 'block' } }, ...hitLines)
        : results !== null
          ? createElement('div', { className: 'zkb-srow' }, createElement('span', { className: 'zkb-hint' }, `没有匹配${results.note !== undefined && results.note !== '' ? `(${results.note})` : ''}`))
          : null,
    ),
    // ── 文件列表卡 ──
    createElement('div', { className: 'zkb-card' },
      createElement('div', { className: 'zkb-srow' },
        createElement('span', { className: 'zkb-sk' }, '已导入文件'),
        createElement('span', { className: 'zkb-hint', style: { marginLeft: 'auto' } }, '删除即从索引移除,原文件不受影响'),
      ),
      (list?.files ?? []).length === 0
        ? createElement('div', { className: 'zkb-srow' }, createElement('span', { className: 'zkb-hint' }, '还没有导入文件。'))
        : createElement('div', { className: 'zkb-files' },
            ...(list?.files ?? []).map((f: FileEntry) => createElement('div', { className: 'zkb-frow', key: f.path },
              createElement('span', { className: `zkb-dot ${f.status === 'done' ? 'zkb-ok' : f.status === 'failed' ? 'zkb-bad' : 'zkb-mid'}` }),
              createElement('span', { className: 'zkb-fpath', title: f.error !== undefined ? f.error : f.path }, f.path),
              createElement('span', { className: 'zkb-fmeta' }, f.status === 'done' ? `${f.chunks} 块` : f.status === 'indexing' ? '索引中' : '失败'),
              createElement('button', { className: 'zkb-btn', style: { padding: '4px 10px', fontSize: '11px' }, onClick: () => { void doRemove(f.path) } }, '删除'),
            )),
          ),
    ),
  )
}

export function apply(ctx: ClientContext): void {
  // 与 dsh-opencli 相同的注册路径;slots 的 'settings.section' 槽位名声明在宿主 ui-settings 包里,
  // 本包类型树拉不到该增强,这里局部收窄(运行时行为一致)
  const slots = ctx.slots as unknown as {
    inject: (slot: string, fn: () => unknown) => void
    register: (options: { name: string; id: string; order: number; label: string }, component: () => unknown) => () => void
  }
  slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'zvec-kb', order: 42, label: '本地知识库' },
    () => createElement(Panel),
  ))
}
