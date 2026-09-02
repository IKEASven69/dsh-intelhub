import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerdicts, llmRefine } from './refine.js'
import { makeCandidate, type Candidate } from './distill.js'

const c = (text: string, type = 'decision'): Candidate =>
  makeCandidate({ text, type, project: 'p', confidence: 0.7, source_rule: type })

test('parseVerdicts: 正常 JSON / 围栏包裹 / 垃圾输入', () => {
  const v1 = parseVerdicts('[{"i":0,"k":true},{"i":1,"k":false},{"i":2,"k":true,"t":"改写","y":"lesson"}]')
  assert.equal(v1.size, 3)
  assert.equal(v1.get(1)!.keep, false)
  assert.equal(v1.get(2)!.text, '改写')
  assert.equal(v1.get(2)!.type, 'lesson')

  const v2 = parseVerdicts('```json\n[{"i":0,"k":false}]\n```')
  assert.equal(v2.size, 1)

  assert.equal(parseVerdicts('不是 JSON').size, 0)
  assert.equal(parseVerdicts('[{"i":"x","k":1}]').size, 0) // 字段类型错
})

test('llmRefine: 丢弃/保留/改写各就各位', async () => {
  const cands = [c('决定用 SQLite'), c('让我检查一下日志'), c('改用 pnpm 跑脚本')]
  const out = await llmRefine(cands, async () =>
    '[{"i":0,"k":true},{"i":1,"k":false},{"i":2,"k":true,"t":"本项目脚本统一用 pnpm 执行"}]')
  assert.equal(out.length, 2)
  assert.equal(out[0].text, '决定用 SQLite')
  assert.equal(out[1].text, '本项目脚本统一用 pnpm 执行')
  assert.ok(out[1].source_rule.includes('+llm'))
  assert.ok(out[1].confidence > 0.7)
})

test('llmRefine: LLM 失败/超时/垃圾输出 → 原样返回（纯规则降级）', async () => {
  const cands = [c('a'), c('b')]
  const boom = llmRefine(cands, async () => { throw new Error('connection refused') })
  assert.equal((await boom).length, 2)
  const garbage = llmRefine(cands, async () => '我觉得都不错')
  assert.equal((await garbage).length, 2)
  // LLM 漏判的编号 = 原样保留（宁多勿丢）
  const partial = await llmRefine(cands, async () => '[{"i":0,"k":false}]')
  assert.equal(partial.length, 1)
  assert.equal(partial[0].text, 'b')
})

test('llmRefine: 空候选直接返回', async () => {
  let called = false
  const out = await llmRefine([], async () => { called = true; return '[]' })
  assert.equal(out.length, 0)
  assert.equal(called, false)
})

test('parseVerdicts: 思考模型输出先剥 <think> 块（思考内有 [ 字符也不受污染）', () => {
  const raw = '<think>The user wants me to evaluate 0. [decision] and 1. [lesson] candidates...</think>\n[{"i":0,"k":false},{"i":1,"k":true}]'
  const v = parseVerdicts(raw)
  assert.equal(v.size, 2)
  assert.equal(v.get(0)!.keep, false)
  assert.equal(v.get(1)!.keep, true)
  // think 未闭合（max_tokens 截断）→ 不可解析
  assert.equal(parseVerdicts('<think>半截思考 [0] 未完').size, 0)
})
