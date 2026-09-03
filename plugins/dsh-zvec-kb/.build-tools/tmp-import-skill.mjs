// 一次性驱动脚本:在 cordis Context 下挂一个 ZvecKbService,然后调 importPath 导入 SKILL.md。
// tools 与 systemPrompt 注册为桩(本脚本不需要它们工作,只是为了 run 完 init 不抛)。
// 用法:NODE_PATH=<plugin>/node_modules node tmp-import-skill.mjs <absolute-path>
import { Context } from '@deepseek-ai/cordis'
import { ZvecKbService } from '../lib/index.js'

const target = process.argv[2]
if (!target) {
  console.error('usage: node tmp-import-skill.mjs <absolute-path>')
  process.exit(2)
}

// 桩服务:仅满足 init() 内的 this.ctx.tools.register / this.ctx.systemPrompt.section 调用
class StubToolsService {
  register(/* toolDef */) { /* no-op */ }
}
class StubSystemPromptService {
  section(/* spec */) { /* no-op */ }
}

const ctx = new Context()
ctx.provide('tools', new StubToolsService())
ctx.provide('systemPrompt', new StubSystemPromptService())

const svc = new ZvecKbService(ctx)
await svc.init()

const beforeList = await svc.listFiles()
const beforeByPath = new Map(beforeList.files.map((f) => [f.path, f]))

const t0 = Date.now()
const result = await svc.importPath(target)
const queuedMs = Date.now() - t0
console.log(`[kb_import] queued=${result.queued} skippedUnchanged=${result.skippedUnchanged} failedScan=[${result.failedScan.join(', ')}] ok=${result.ok} error=${result.error ?? ''}`)

// 等队列耗尽(后台串行抽 → 嵌 → 入库)
const drainT0 = Date.now()
await svc.drain()
const drainMs = Date.now() - drainT0

const after = await svc.listFiles()
console.log(`[queue drained] ${after.indexing} in flight, ${drainMs}ms waiting.`)
console.log(`[registry] ${after.files.length} files, ${after.files.reduce((s, f) => s + (f.status === 'done' ? f.chunks : 0), 0)} done chunks total.`)

const nowEntry = after.files.find((f) => f.path === target)
if (nowEntry) {
  console.log(`[target entry] path=${nowEntry.path}`)
  console.log(`              id=${nowEntry.id}`)
  console.log(`              bytes=${nowEntry.bytes}`)
  console.log(`              chunks=${nowEntry.chunks}`)
  console.log(`              status=${nowEntry.status}`)
  console.log(`              importedAt=${new Date(nowEntry.importedAt).toISOString()}`)
  console.log(`              importedAtDeltaFromImport=${nowEntry.importedAt - t0}ms`)
} else {
  console.log('[target entry] NOT FOUND in registry after drain.')
}

const before = beforeByPath.get(target)
console.log(`[before vs after] beforeStatus=${before?.status ?? '<absent>'} afterStatus=${nowEntry?.status ?? '<absent>'}`)

svc.shutdown()
