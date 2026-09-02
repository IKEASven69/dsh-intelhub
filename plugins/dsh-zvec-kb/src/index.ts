/**
 * dsh-zvec-kb host 半:zvec 原生本地知识库。
 * - kb_import:文件/整个文件夹导入(后台队列:抽取→分块→本地向量化→入库,逐文件可见)
 * - kb_search:语义+关键词加权混合检索(zvec weighted 融合),结果带 文件路径#块 来源
 * - kb_list / kb_delete:注册表管理与按文件删除
 * - TypertRemoteService RPC:status / list / import / remove / search(面板用)
 * 零守护进程(zvec 进程内)、零 API key(e5-small 本地推理)、文档不出本机。
 * @module dsh-zvec-kb
 */

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// 仅类型面:拉入 dsh 宿主对 cordis Context 的增强(systemPrompt 服务声明);SWC 会擦除,不进运行时依赖
import type {} from '@deepseek-ai/dsh-system-prompt'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { chunkText, embedTextOf } from './chunker.ts'
import { E5Embedder } from './embedder.ts'
import type { Embedder } from './embedder.ts'
import { KbStore } from './store.ts'
import type { RawHit } from './store.ts'
import { extractText, SUPPORTED_EXTS, MAX_FILE_BYTES } from './extract.ts'
import type { FileEntry, ImportResult, ListResult, RemoveResult, SearchHit, SearchResult, StatusResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    zvecKb: ZvecKbService
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.cache'])
const MAX_FILES_PER_IMPORT = 2000
const SNIPPET = 300

/** 路径规范化键(大小写与分隔符不敏感)。 */
const normKey = (p: string): string => resolve(p).split(sep).join('/').toLowerCase()

export class ZvecKbService extends TypertRemoteService {
  static inject = ['tools', 'systemPrompt']

  private readonly homeDir: string
  private embedder: Embedder | null = null
  private store: KbStore | null = null
  private registry = new Map<string, FileEntryInternal>()
  private registryLoaded = false
  private queueTail: Promise<void> = Promise.resolve()
  private queuedFiles = 0
  private promptText = '本地知识库(dsh-zvec-kb):还没有已导入的文档。用户给路径时可调 kb_import 导入(支持整个文件夹)。'

  constructor(ctx: Context) {
    super(ctx, 'zvecKb')
    this.homeDir = process.env.DSH_ZVECKB_HOME ?? join(homedir(), '.dsh', 'dsh-zvec-kb')
    // 不注册 dispose 钩子:zvec WAL 保证崩溃安全,进程退出无需显式关库
  }

  /** 测试注入点:子类覆盖以替换向量器。 */
  protected createEmbedder(): Embedder {
    void mkdir(join(this.homeDir, 'hf-cache'), { recursive: true })
    return new E5Embedder(join(this.homeDir, 'hf-cache'))
  }

  // ── 生命周期:工具 + systemPrompt ─────────────────────────

  async init(): Promise<void> {
    await this.loadRegistry()
    this.registerTools()
    this.ctx.systemPrompt.section({
      name: 'zvec-kb',
      order: 160,
      text: () => this.promptText,
    })
    this.refreshPrompt()
  }

  private refreshPrompt(): void {
    const done = [...this.registry.values()].filter((f) => f.status === 'done')
    if (done.length === 0) {
      this.promptText = '本地知识库(dsh-zvec-kb):还没有已导入的文档。用户给路径时可调 kb_import 导入(支持整个文件夹)。'
      return
    }
    const sample = done.slice(-5).map((f) => f.path).join('、')
    this.promptText = `本地知识库(dsh-zvec-kb):已导入 ${done.length} 个文件(如 ${sample})。用户问题涉及这些文档内容时,先用 kb_search 检索(语义+关键词混合,能按意思找到换了说法的段落),结果带 文件路径#块号 来源,引用时注明。检索不到再问用户或看原文件。新增文档用 kb_import(支持文件夹),移除用 kb_delete。`
  }

  private registerTools(): void {
    this.ctx.tools.register(defineTool({
      name: 'kb_search',
      description: '在用户的本地知识库里检索(语义+关键词混合:按意思能找到换说法的段落,精确词/错误码也能命中)。用户问题涉及已导入文档时先用它,结果带 文件路径#块号 来源。',
      parameters: {
        query: { type: 'string', description: '检索词:自然语言问题或关键词均可' },
        topk: { type: 'number', description: '返回条数,默认 5' },
      },
      output: { schema: { type: 'json' }, render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] },
      execute: async (a: { query?: unknown; topk?: unknown }): Promise<{ text: string }> => {
        const q = String(a.query ?? '').trim()
        if (!q) return { text: 'query 不能为空。' }
        const topk = Math.min(Math.max(Number(a.topk) || 5, 1), 20)
        const r = await this.search(q, topk)
        if (!r.ok) return { text: `检索失败:${r.error ?? '未知'}` }
        if (r.hits.length === 0) return { text: `知识库中没有匹配"${q}"的内容${r.note ? `(${r.note})` : ''}。` }
        const lines = r.hits.map((h, i) => `[${i + 1}] ${h.score.toFixed(3)} · ${h.ref}\n${h.text.length > SNIPPET ? h.text.slice(0, SNIPPET) + '…' : h.text}`)
        return { text: `知识库检索"${q}"(${r.mode}${r.note ? ',' + r.note : ''}),${r.hits.length} 条:\n\n${lines.join('\n\n')}` }
      },
    }))

    this.ctx.tools.register(defineTool({
      name: 'kb_import',
      description: '导入文件或整个文件夹到本地知识库(md/txt/pdf/docx/代码等)。后台建索引,立即返回队列情况;重复导入只处理新增/变更文件。',
      parameters: {
        path: { type: 'string', description: '文件或文件夹的绝对路径(支持 ~)' },
      },
      output: { schema: { type: 'json' }, render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] },
      execute: async (a: { path?: unknown }): Promise<{ text: string }> => {
        const r = await this.importPath(String(a.path ?? ''))
        if (!r.ok) return { text: `导入失败:${r.error ?? '未知'}` }
        const parts = [`已加入索引队列:${r.queued} 个文件`]
        if (r.skippedUnchanged > 0) parts.push(`无变化跳过:${r.skippedUnchanged}`)
        if (r.failedScan.length > 0) parts.push(`扫描失败:${r.failedScan.join('、')}(前 5)`)
        parts.push('后台索引进行中,完成后即可检索;进度可看 dsh 设置→本地知识库。')
        return { text: parts.join(';') + '.' }
      },
    }))

    this.ctx.tools.register(defineTool({
      name: 'kb_list',
      description: '列出本地知识库已导入的文件、块数与索引状态。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] },
      execute: async (): Promise<{ text: string }> => {
        const files = [...this.registry.values()].sort((x, y) => y.importedAt - x.importedAt)
        if (files.length === 0) return { text: '知识库为空。用 kb_import 导入文件或文件夹。' }
        const rows = files.map((f) => `${f.status === 'done' ? '✓' : f.status === 'failed' ? '✗' : '…'} ${f.chunks}块 ${f.path}${f.error ? ` (${f.error})` : ''}`)
        return { text: `知识库 ${files.length} 个文件:\n${rows.join('\n')}` }
      },
    }))

    this.ctx.tools.register(defineTool({
      name: 'kb_delete',
      description: '从知识库移除一个已导入的文件(按导入路径,支持只给结尾一段唯一路径)。',
      parameters: {
        path: { type: 'string', description: '导入时的文件路径(或其唯一后缀)' },
      },
      output: { schema: { type: 'json' }, render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }] },
      execute: async (a: { path?: unknown }): Promise<{ text: string }> => {
        const r = await this.remove(String(a.path ?? ''))
        if (!r.ok) return { text: `删除失败:${r.error ?? '未知'}` }
        return { text: r.removed ? '已从知识库移除。' : '没有匹配的已导入文件。' }
      },
    }))
  }

  // ── 运行时(向量器 + 存储,惰性) ──────────────────────────

  private async ensureRuntime(): Promise<{ embedder: Embedder; store: KbStore } | { error: string }> {
    if (this.embedder === null) {
      // 真实环境走 e5;测试子类通过覆盖 createEmbedder 注入假向量器
      this.embedder = this.createEmbedder()
    }
    if (this.store === null) {
      await mkdir(this.homeDir, { recursive: true })
      const s = new KbStore(join(this.homeDir, 'store'), this.embedder.dim)
      s.open()
      if (!s.ok) {
        return { error: `zvec 存储打开失败:${s.error ?? '未知'}` }
      }
      this.store = s
    }
    return { embedder: this.embedder, store: this.store }
  }

  // ── 导入 ────────────────────────────────────────────────

  async importPath(input: string): Promise<ImportResult> {
    const raw = input.trim().replace(/^~(?=$|[/\\])/, homedir())
    const p = resolve(raw)
    let st
    try {
      st = await stat(p)
    } catch {
      return { ok: false, queued: 0, skippedUnchanged: 0, failedScan: [], error: `路径不存在:${p}` }
    }
    await this.loadRegistry()

    const files: string[] = []
    const failedScan: string[] = []
    if (st.isFile()) {
      files.push(p)
    } else {
      const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const e of entries) {
          if (files.length >= MAX_FILES_PER_IMPORT) return
          const fp = join(dir, e.name)
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(fp)
          } else if (SUPPORTED_EXTS.has(extLower(e.name))) {
            files.push(fp)
          }
        }
      }
      try {
        await walk(p)
      } catch (err: unknown) {
        failedScan.push(err instanceof Error ? err.message.slice(0, 80) : '目录扫描错误')
      }
    }

    let queued = 0
    let skippedUnchanged = 0
    const candidates: { path: string; bytes: number }[] = []
    for (const fp of files) {
      try {
        const s = await stat(fp)
        if (s.size > MAX_FILE_BYTES) {
          failedScan.push(`${fp}(超过 ${Math.round(MAX_FILE_BYTES / 1048576)}MB)`)
          continue
        }
        candidates.push({ path: fp, bytes: s.size })
      } catch {
        failedScan.push(`${fp}(不可读)`)
      }
    }
    // 大小相同且此前 done 的先乐观跳过;内容级去重在队列里按 hash 处理
    for (const c of candidates) {
      const prev = this.registry.get(normKey(c.path))
      if (prev !== undefined && prev.status === 'done' && prev.bytes === c.bytes) {
        skippedUnchanged++
        continue
      }
      this.registry.set(normKey(c.path), { ...entryOf(c.path), bytes: c.bytes, status: 'indexing' as const, chunks: prev?.chunks ?? 0 })
      queued++
      this.enqueue(c.path, c.bytes)
    }
    if (queued > 0 || failedScan.length > 0) this.saveRegistry()
    this.refreshPrompt()
    return { ok: true, queued, skippedUnchanged, failedScan: failedScan.slice(0, 5) }
  }

  /** 串行后台队列:逐文件 抽取→分块→向量化→入库,失败记入注册表不阻断后续。 */
  private enqueue(path: string, bytes: number): void {
    this.queuedFiles++
    this.queueTail = this.queueTail.then(async () => {
      try {
        await this.indexFile(path, bytes)
      } catch (err: unknown) {
        const key = normKey(path)
        const cur = this.registry.get(key)
        this.registry.set(key, { ...(cur ?? entryOf(path)), bytes, status: 'failed', error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) })
        this.saveRegistry()
        this.refreshPrompt()
      } finally {
        this.queuedFiles--
      }
    })
  }

  private async indexFile(path: string, bytes: number): Promise<void> {
    const rt = await this.ensureRuntime()
    if ('error' in rt) throw new Error(rt.error)
    const { text, reason } = await extractText(path)
    if (text === null) throw new Error(reason ?? '无法抽取文本')
    const buf = Buffer.from(text, 'utf8')
    const id = createHash('sha256').update(buf).digest('hex').slice(0, 16)
    const chunks = chunkText(text)
    if (chunks.length === 0) throw new Error('没有可索引的内容')

    const key = normKey(path)
    const prev = this.registry.get(key)
    // 同路径旧内容清理(内容变了 file id 变);首次导入 prev.id 为空串,跳过
    if (prev !== undefined && prev.id !== '' && prev.id !== id) rt.store.deleteFile(prev.id)

    if (rt.embedder.ready !== null) await rt.embedder.ready
    // 嵌入用去语法文本(余弦不被 markdown 符号污染);FTS/展示仍用原文
    const vectors = await rt.embedder.embed(chunks.map((c) => embedTextOf(c)))
    rt.store.insert(id, chunks, vectors)
    this.registry.set(key, { id, path: resolve(path), bytes, chunks: chunks.length, status: 'done', importedAt: Date.now() })
    this.saveRegistry()
    this.refreshPrompt()
  }

  // ── 检索 ────────────────────────────────────────────────

  async search(query: string, topk: number): Promise<SearchResult> {
    const rt = await this.ensureRuntime()
    if ('error' in rt) return { ok: false, mode: 'none', hits: [], error: rt.error }
    let queryVec: number[] | null = null
    let note: string | undefined
    if (rt.embedder.ready === null) {
      // 假向量器(测试)或同步可用的实现
      queryVec = (await rt.embedder.embed([query], true))[0]
    } else {
      // 真模型冷启动可能要下载(秒级到十秒级);1.5s 内没就绪就先走 FTS,不让工具调用干等
      const ready = await Promise.race([rt.embedder.ready.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 1500))])
      if (ready) {
        queryVec = (await rt.embedder.embed([query], true))[0]
      } else {
        note = '语义模型加载中,本次为关键词检索'
      }
    }
    const raw: RawHit[] = rt.store.search(queryVec, query, topk)
    const byId = new Map([...this.registry.values()].map((f) => [f.id, f]))
    const hits: SearchHit[] = raw.map((r) => ({
      ref: `${byId.get(r.file)?.path ?? r.file}#${r.chunk}`,
      score: r.score,
      text: r.text,
    }))
    return { ok: true, mode: queryVec === null ? 'fts' : 'hybrid', hits, note }
  }

  // ── 列表 / 删除 / 状态 ───────────────────────────────────

  async remove(input: string): Promise<RemoveResult> {
    await this.loadRegistry()
    const key = normKey(input)
    let entry = this.registry.get(key)
    if (entry === undefined) {
      const lower = input.toLowerCase()
      const matches = [...this.registry.values()].filter((f) => f.path.toLowerCase() === lower || f.path.toLowerCase().endsWith(lower) || f.path.toLowerCase().endsWith('/' + lower))
      if (matches.length === 1) entry = matches[0]
      else if (matches.length > 1) return { ok: false, removed: false, error: `路径不唯一(${matches.length} 个匹配),请给完整路径` }
    }
    if (entry === undefined) return { ok: true, removed: false }
    if (this.store === null) {
      const rt = await this.ensureRuntime()
      if ('error' in rt) return { ok: false, removed: false, error: rt.error }
    }
    try {
      this.store?.deleteFile(entry.id)
    } catch (err: unknown) {
      return { ok: false, removed: false, error: err instanceof Error ? err.message : String(err) }
    }
    this.registry.delete(normKey(entry.path))
    this.saveRegistry()
    this.refreshPrompt()
    return { ok: true, removed: true }
  }

  async listFiles(): Promise<ListResult> {
    await this.loadRegistry()
    const files = [...this.registry.values()].sort((x, y) => y.importedAt - x.importedAt)
    return { ok: true, files, indexing: this.queuedFiles }
  }

  async statusInfo(): Promise<StatusResult> {
    const rt = await this.ensureRuntime().catch(() => null)
    await this.loadRegistry()
    const files = [...this.registry.values()]
    let model: 'ready' | 'loading' | 'absent' = 'absent'
    if (rt !== null && !('error' in rt)) {
      const e = rt.embedder
      model = e.ready === null ? 'ready' : await Promise.race([e.ready.then(() => 'ready' as const), new Promise<'loading'>((res) => setTimeout(() => res('loading'), 50))])
    }
    return {
      ok: rt !== null && !('error' in rt),
      home: this.homeDir,
      files: files.length,
      chunks: files.reduce((s, f) => s + (f.status === 'done' ? f.chunks : 0), 0),
      indexing: this.queuedFiles,
      model,
      dim: this.embedder?.dim ?? null,
      error: rt !== null && 'error' in rt ? rt.error : undefined,
    }
  }

  // ── RPC(面板) ────────────────────────────────────────────

  @Remote('status')
  async rpcStatus(): Promise<StatusResult> {
    return await this.statusInfo()
  }

  @Remote('list')
  async rpcList(): Promise<ListResult> {
    return await this.listFiles()
  }

  @Remote('import')
  async rpcImport(p: { path: string }): Promise<ImportResult> {
    return await this.importPath(p.path)
  }

  @Remote('remove')
  async rpcRemove(p: { path: string }): Promise<RemoveResult> {
    return await this.remove(p.path)
  }

  @Remote('search')
  async rpcSearch(p: { query: string; topk: number }): Promise<SearchResult> {
    return await this.search(p.query, p.topk)
  }

  /** 队列排空(测试等待用)。 */
  async drain(): Promise<void> {
    await this.queueTail
    await this.saveTail
  }

  /** 立即释放 zvec 写锁(进程内测试与优雅退出用)。 */
  shutdown(): void {
    this.store?.close()
    this.store = null
  }

  // ── 注册表持久化 ─────────────────────────────────────────

  private get registryPath(): string {
    return join(this.homeDir, 'registry.json')
  }

  private async loadRegistry(): Promise<void> {
    if (this.registryLoaded) return
    this.registryLoaded = true
    try {
      const raw = JSON.parse(await readFile(this.registryPath, 'utf8')) as { files?: FileEntryInternal[] }
      for (const f of raw.files ?? []) this.registry.set(normKey(f.path), { ...f, bytes: f.bytes ?? 0 })
    } catch {
      /* 首次运行无注册表 */
    }
  }

  private saveTail: Promise<void> = Promise.resolve()

  /** 尾随式持久化:合并排队写盘,最后一次状态必然落盘。 */
  private saveRegistry(): void {
    this.saveTail = this.saveTail.then(async () => {
      try {
        await mkdir(this.homeDir, { recursive: true })
        await writeFile(this.registryPath, JSON.stringify({ version: 1, files: [...this.registry.values()] }, null, 2), 'utf8')
      } catch {
        /* 持久化失败不阻断索引 */
      }
    })
  }
}

/** FileEntry 运行时含 bytes(注册表字段);类型合并放这里避免污染公共类型。 */
export interface FileEntryInternal extends FileEntry {
  bytes: number
}

function entryOf(path: string): FileEntryInternal {
  return { id: '', path: resolve(path), chunks: 0, status: 'indexing', importedAt: Date.now(), bytes: 0 }
}

function extLower(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i).toLowerCase()
}

export default ZvecKbService
