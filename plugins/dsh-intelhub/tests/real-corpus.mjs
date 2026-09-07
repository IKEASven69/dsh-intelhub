// 磨1: 真实文档实战验收——monorepo 全部真实 md + 2 个真 office 文件 + 1 个网页,27+ 真实复杂文档
// 验收点:导入容错(乱文件)、检索质量(人 judgement 的自然问题)、来源正确、幽灵条目自愈
import { mkdtemp, mkdir, writeFile, cp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const home = await mkdtemp(join(tmpdir(), 'zveckb-real-'))
process.env.DSH_INTELHUB_HOME = home
const spikeCache = 'D:/CodingProjects/dsh-plugin/spikes/zvec-kb/node_modules/@huggingface/transformers/.cache'
if (existsSync(spikeCache)) {
  await mkdir(join(home, 'hf-cache'), { recursive: true })
  await cp(spikeCache, join(home, 'hf-cache'), { recursive: true })
}

// 组装真实语料目录:仓库 md + 手造的"脏"文件(用户真会有的东西)
const docs = join(home, 'docs')
await mkdir(join(docs, 'sub'), { recursive: true })
const repo = 'D:/CodingProjects/dsh-plugin'
const mds = []
async function collect(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const fp = join(dir, e.name)
    if (e.isDirectory()) await collect(fp)
    else if (e.name.endsWith('.md')) mds.push(fp)
  }
}
await collect(repo)
for (const f of mds) await cp(f, join(docs, f.split(/[\\/]/).pop().replace(/\.md$/, `-${mds.indexOf(f)}.md`))).catch(() => {})
console.log('真实 md 语料:', mds.length)

// 脏文件:空文件、纯代码无段落、超长单行、二进制扩展名伪装
await writeFile(join(docs, 'empty.md'), '', 'utf8')
await writeFile(join(docs, 'one-liner.md'), 'x'.repeat(3000), 'utf8')
await writeFile(join(docs, 'code-only.py'), 'import os\nimport sys\ndef main():\n    print("hello")\n', 'utf8')
await writeFile(join(docs, 'sub', 'nested-deep.md'), '# 深层文档\n\n这是嵌套两层目录里的真实内容,锚点 DEEP-NEST-7。', 'utf8')

const { ZvecKbService } = await import('../lib/index.js')
const { Context, Service } = await import('@deepseek-ai/cordis')
class StubTools extends Service { constructor(c) { super(c, 'tools') } register() {} }
class StubPrompt extends Service { constructor(c) { super(c, 'systemPrompt') } section() {} }
const ctx = new Context()
await ctx.plugin(StubTools); await ctx.plugin(StubPrompt); await ctx.plugin(ZvecKbService)
const svc = ctx.intelhub

const imp = await svc.importPath(docs)
console.log(`导入: queued=${imp.queued} failedScan=${JSON.stringify(imp.failedScan)}`)
const t0 = performance.now()
await svc.drain()
console.log(`索引完成 ${((performance.now() - t0) / 1000).toFixed(1)}s`)
const list = await svc.listFiles()
const failed = list.files.filter((f) => f.status === 'failed')
console.log(`文件 ${list.files.length} 个, 失败 ${failed.length}${failed.length ? ': ' + failed.map((f) => f.path.split(/[\\/]/).pop() + '(' + f.error + ')').join(', ') : ''}`)

// 真实问题集(人 natural judgement,不依赖锚点):每题给出应命中的语义区域
const realQueries = [
  ['opencli 的审批门是干什么的', '审批'],
  ['怎么把微博内容存进知识库', '抓取'],
  ['内存架构是怎么设计的', '内存|记忆|memory'],
  ['发布计划里下一步做什么', '发布|release'],
  ['测试报告结论是什么', '测试|report'],
  ['handoff 文档是给谁的', 'handoff|交接'],
  ['agentforge 是干什么的', 'agentforge|大脑|brain'],
  ['嵌套在子目录里的那份文档说了什么', 'DEEP-NEST|深层'],
]
let pass = 0
for (const [q, expect] of realQueries) {
  const r = await svc.search(q, 5)
  const joined = r.hits.map((h) => h.text).join('\n') + ' ' + r.hits.map((h) => h.ref).join('\n')
  const ok = new RegExp(expect, 'i').test(joined)
  if (ok) pass++
  console.log(`${ok ? '✓' : '✗'} ${q} → ${r.hits[0]?.ref?.slice(-45) ?? '无结果'}`)
}
console.log(`真实问题命中: ${pass}/${realQueries.length}`)

// 幽灵条目自愈验证:手工造"注册表有、store 无"的条目,再导入同路径 → 应自动清理重建
const ghostPath = join(docs, 'sub', 'nested-deep.md')
const key = ghostPath.toLowerCase()
svc.registry.set(key, { id: 'ghost0000000000', path: ghostPath, bytes: 100, chunks: 3, status: 'done', importedAt: Date.now() })
const reimp = await svc.importPath(ghostPath)
await svc.drain()
const after = await svc.search('DEEP-NEST-7', 3)
const ghostGone = !after.hits.some((h) => h.ref.includes('ghost0000000000'))
const nowFound = after.hits.some((h) => h.text.includes('DEEP-NEST-7'))
console.log(`幽灵条目自愈: 重导入 queued=${reimp.queued} | 幽灵ref消失=${ghostGone} | 新内容可召回=${nowFound}`)

svc.shutdown()
console.log('\nREAL-CORPUS DONE', home)
