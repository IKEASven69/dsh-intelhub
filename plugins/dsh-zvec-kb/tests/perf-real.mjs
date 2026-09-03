// 千块级压测 + 多途径混合导入 + 并发场景(补 1/3/4)
import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const home = await mkdtemp(join(tmpdir(), 'zveckb-perf-'))
process.env.DSH_ZVECKB_HOME = home
const spikeCache = 'D:/CodingProjects/dsh-plugin/spikes/zvec-kb/node_modules/@huggingface/transformers/.cache'
if (existsSync(spikeCache)) {
  await mkdir(join(home, 'hf-cache'), { recursive: true })
  await cp(spikeCache, join(home, 'hf-cache'), { recursive: true })
}

// 造语料:120 个文件 × 每个约 10 块 ≈ 1200 块,内容带可检索锚点
const docsDir = join(home, 'docs')
await mkdir(docsDir, { recursive: true })
for (let f = 0; f < 120; f++) {
  const parts = [`# 文档 ${f} 操作手册`]
  for (let s = 0; s < 10; s++) {
    parts.push(`## 章节 ${f}-${s}\n\n本节描述模块 ${f} 的功能 ${s}:包括参数配置、异常处理与日志输出。锚点 ANCHOR-${f}-${s} 标记本节,用于检索定位与回归验证。相关错误码 ERR-${f}${s} 表示资源竞争。`)
  }
  await writeFile(join(docsDir, `manual-${String(f).padStart(3, '0')}.md`), parts.join('\n\n'), 'utf8')
}
console.log('语料就绪: 120 文件')

const { ZvecKbService } = await import('../lib/index.js')
const { Context, Service } = await import('@deepseek-ai/cordis')
class StubTools extends Service { constructor(c) { super(c, 'tools') } register() {} }
class StubPrompt extends Service { constructor(c) { super(c, 'systemPrompt') } section() {} }
const ctx = new Context()
await ctx.plugin(StubTools); await ctx.plugin(StubPrompt); await ctx.plugin(ZvecKbService)
const svc = ctx.zvecKb

// ── 补4:多途径同时进(文件夹 + URL + note 三途径交错)──
console.log('\n== 多途径混合导入 ==')
const t0 = performance.now()
const [fsR, noteR] = await Promise.all([
  svc.importPath(docsDir),
  svc.importNote('混合导入-笔记', '这是一条与文件夹同时导入的笔记,锚点 MIXED-NOTE-99,验证多途径并行不互踩。'),
])
console.log(`文件夹 queued=${fsR.queued} | note queued=${noteR.queued} | 并行提交 ${((performance.now() - t0) / 1000).toFixed(2)}s`)
// URL 腿(真实网络)
const urlR = await svc.importUrls(['https://example.com'])
console.log(`URL queued=${urlR.queued}`)

// ── 补1:千块级导入耗时(含向量化)──
console.log('\n== 千块级索引 ==')
const mem0 = process.memoryUsage().rss
const t1 = performance.now()
await svc.drain()
const indexMs = performance.now() - t1
const st = await svc.statusInfo()
console.log(`索引用时: ${(indexMs / 1000).toFixed(1)}s | 文件 ${st.files} | 块 ${st.chunks} | RSS ${Math.round(mem0 / 1048576)}MB`)
const perFile = (indexMs / fsR.queued / 1000).toFixed(2)
console.log(`均摊: ${perFile}s/文件(含 e5 向量化)`)

// ── 补1:千块库检索延迟 ──
console.log('\n== 千块库检索延迟(10 次均值)==')
const queries = ['模块 3 的功能 5 怎么配置', 'ERR-77 是什么错误', 'ANCHOR-42-8 在哪里', '日志输出异常怎么处理', '资源竞争的错误码', '怎么配置超时时间', '文档 100 的章节 3', 'ANCHOR-7-7', '模块 99 功能 1', '参数配置与异常处理']
let total = 0
for (const q of queries) {
  const t = performance.now()
  const r = await svc.search(q, 5)
  const ms = performance.now() - t
  total += ms
  console.log(`  ${ms.toFixed(0).padStart(4)}ms | ${r.hits[0]?.ref?.split(/[\\/]/).pop() ?? '-'} | ${q}`)
}
console.log(`均值: ${(total / queries.length).toFixed(0)}ms`)

// ── 补1:千块库检索质量(锚点命中@1)──
let hit = 0
const N = 20
for (let i = 0; i < N; i++) {
  const f = Math.floor(Math.random() * 120), s = Math.floor(Math.random() * 10)
  const r = await svc.search(`ANCHOR-${f}-${s}`, 3)
  if (r.hits.some((h) => h.text.includes(`ANCHOR-${f}-${s}`))) hit++
}
console.log(`锚点命中: ${hit}/${N}`)

// ── 补3:并发场景(索引进行中检索/删除)──
console.log('\n== 并发:导入中检索与删除 ==')
// 追加 30 个文件,趁队列未清空时检索+删除
const docsDir2 = join(home, 'docs2')
await mkdir(docsDir2, { recursive: true })
for (let f = 0; f < 30; f++) await writeFile(join(docsDir2, `more-${f}.md`), `# 追加文档 ${f}\n\n并发验证内容,锚点 CONC-${f}。`, 'utf8')
const bg = await svc.importPath(docsDir2)
console.log(`追加 queued=${bg.queued},立刻检索:`)
const midSearch = await svc.search('CONC-5', 3)
console.log(`  索引进行中检索返回 ${midSearch.hits.length} 条(部分索引可见,不报错)`)
const midDel = await svc.remove(join(docsDir, 'manual-000.md'))
console.log(`  索引进行中删除 manual-000: ok=${midDel.ok}`)
await svc.drain()
const after = await svc.statusInfo()
console.log(`排空后: files=${after.files} chunks=${after.chunks}`)
// 已删文件不再命中
const delCheck = await svc.search('ANCHOR-0-0', 3)
console.log(`已删 manual-000 锚点残留: ${delCheck.hits.filter((h) => h.text.includes('ANCHOR-0-')).length} 条(应为 0)`)

svc.shutdown()
console.log('\nPERF-E2E DONE', home)
