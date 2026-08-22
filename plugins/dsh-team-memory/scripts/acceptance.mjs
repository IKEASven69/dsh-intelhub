/**
 * T0/T1 验收脚本（fixture 驱动）：按 rc.8 fold.ts 真实 schema 造一支三人团队
 * （两条消息踩同一个坑 → 晋升信号），跑完整管线：事件 → L1 私有（引擎+账本）
 * → L2 晋升 → fold 视图。HIPPO_DATA_DIR 指到临时目录，不污染真实库。
 * 运行：HIPPO_DATA_DIR=<tmp> node scripts/acceptance.mjs
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'team-mem-acc-'))
process.env.HIPPO_DATA_DIR = dir

// 引擎按 HIPPO_DATA_DIR 初始化（晚于 env 设置）
const { distillTeamEvents } = await import('../.tsc/distill.js')

const { foldLedger, ledgerPath } = await import('../.tsc/ledger.js')
const { readTeamEvents } = await import('../.tsc/adapter.js')

const T = 'team-acc-1'
const ev = (e) => ({ version: 1, teamId: T, ...e })
const events = [
  ev({ type: 'team/member', member: { id: 's-a', name: 'alice', description: '前端', provider: 'x', context: 'fresh', phase: 'active' } }),
  ev({ type: 'team/member', member: { id: 's-b', name: 'bob', description: '后端', provider: 'x', context: 'fresh', phase: 'active' } }),
  ev({ type: 'team/member', member: { id: 's-c', name: 'carol', description: '测试', provider: 'x', context: 'fresh', phase: 'active' } }),
  ev({ type: 'team/message/queued', message: { id: 'm-1', senderId: 's-a', senderName: 'alice', targetId: 's-b', delivery: 'quiet', content: [{ type: 'text', text: '决定：构建必须先过 tsc 再 tsdown，rolldown 不转换 stage-3 装饰器，直接打包会语法错误' }] } }),
  ev({ type: 'team/message/queued', message: { id: 'm-2', senderId: 's-b', senderName: 'bob', targetId: 's-a', delivery: 'wakeup', content: [{ type: 'text', text: '踩坑确认：tsdown 打包 stage-3 装饰器会漏进产物报 Invalid token——决定同样采用先 tsc 预编译再打包' }] } }),
  ev({ type: 'team/message/queued', message: { id: 'm-3', senderId: 's-c', senderName: 'carol', targetId: 's-a', delivery: 'quiet', content: [{ type: 'text', text: '午饭吃啥' }] } }),
  ev({ type: 'team/task', task: { id: 'task-1', revision: 1, subject: '接入 memory 面板', description: '设置页加团队记忆列表，含退役审批', status: 'completed', ownerId: 's-a', blockedBy: [], writeScopes: [] } }),
]

console.log('== ① 事件 dump（本机 rc.7 应为 0 条）==')
const dump = readTeamEvents()
console.log('sessions:', dump.sessionsScanned, '| events:', dump.events.length)

console.log('== ② 蒸馏（L1 私有 → L2 晋升）==')
const report = await distillTeamEvents(events, { apply: true })
console.log(JSON.stringify(report, null, 1))

console.log('== ③ 账本 fold 视图 ==')
const view = foldLedger()
console.log('有效条目:', view.entries.length, '| 退役:', view.retired.length)
for (const e of view.entries) {
  console.log(` [${e.scope}] ${e.type}: ${e.text.slice(0, 44)}${e.promotedFrom ? ' ←晋升(' + e.promotedFrom.length + '源)' : ''}`)
}

// 断言
const assert = (c, msg) => { if (!c) { console.error('✗', msg); cleanup(1) } }
assert(report.members === 3, '成员数 3')
assert(report.privateCreated >= 2, '至少 2 条私有（alice/bob 的构建约束）')
assert(report.promotedToTeam >= 1, '至少 1 条晋升（两人互证构建约束）')
const scopes = new Set(view.entries.map((e) => e.scope))
assert(scopes.has(`team:${T}`), '存在团队 scope')
assert(!view.entries.some((e) => /午饭/.test(e.text)), '闲聊不入库（<24 字符初判 chitchat——但引擎规则可能仍提取；宽松校验通过则说明未提取）')
console.log('\n✅ T0/T1 验收通过')

function cleanup(code) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  process.exit(code)
}
cleanup(0)
