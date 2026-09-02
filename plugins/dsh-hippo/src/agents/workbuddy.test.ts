import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workbuddyAdapter } from './workbuddy.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'workbuddy-sample.jsonl')

test('parse: 真实样本 → Turn 序列（message 双向 / 工具对 / 跳过行）', () => {
  const turns = workbuddyAdapter.parse(FIXTURE)
  assert.ok(turns.length > 5, `应有实质轮次，got ${turns.length}`)
  const users = turns.filter(t => t.role === 'user')
  const assistants = turns.filter(t => t.role === 'assistant')
  const tools = turns.filter(t => t.role === 'tool')
  assert.ok(users.length >= 1 && users.every(t => t.text !== ''), 'user 轮有文本')
  assert.ok(assistants.length >= 1, 'assistant 轮存在')
  assert.ok(tools.length >= 4, '工具调用+结果都在')
  // 跳过类型不产生轮次
  assert.ok(!turns.some(t => t.text.includes('__truncated')), 'file-history-snapshot 不进 Turn')
  // 行级 cwd 透传
  const cwds = new Set(turns.map(t => t.cwd).filter(c => c !== ''))
  assert.ok(cwds.size <= 1, `非空 cwd 应一致（真实为 ${[...cwds]}）`)
  // 时间戳是 ISO
  assert.ok(turns.filter(t => t.ts !== '').every(t => t.ts.includes('T')), 'timestamp ms→ISO')
})

test('parse: 失败结果 → toolFailed=true（蒸馏/skill-extract 的信号）', () => {
  const turns = workbuddyAdapter.parse(FIXTURE)
  const failed = turns.filter(t => t.toolFailed)
  assert.ok(failed.length >= 1, '人造失败夹具必须命中')
  assert.ok(failed[0].text.includes('boom'))
  const okResults = turns.filter(t => t.toolName !== '' && !t.toolFailed)
  assert.ok(okResults.length >= 1, 'completed 结果不误标')
})

test('parse: 坏行/不存在文件静默返回空', () => {
  assert.deepEqual(workbuddyAdapter.parse('Z:/nonexist.jsonl'), [])
})

test('discover: 真实环境（本机装了 WorkBuddy）能发现会话且带标题/cwd', () => {
  const refs = workbuddyAdapter.discover()
  assert.ok(refs.length > 0, '本机应有 WorkBuddy 会话')
  const withTitle = refs.filter(r => r.title && !/^[0-9a-f-]{36}$/.test(r.title))
  assert.ok(withTitle.length > 0, `ai-title 提取生效（${withTitle.length}/${refs.length}）`)
  assert.ok(refs.every(r => r.fingerprint.includes(':')), '指纹 = mtime:size')
})
