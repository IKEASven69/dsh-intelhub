/**
 * src/agents 会话适配器单测 —— G0 验收项："每家解析器喂样例文件出预期 Turn 数"。
 * 四家各喂最小真实形态样例（临时文件/临时 sqlite 库），断言 Turn 数量与关键字段；
 * 另覆盖两级 .hippoignore 匹配与增量状态读写往返。
 * 运行：pnpm test（或 npx tsx --test src/agents/agents.test.ts）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

import { claudeAdapter } from './claude.js'
import { parseCodexText } from './codex.js'
import { parseOpenCodeSession } from './opencode.js'
import { parseZcodeSession } from './zcode.js'
import { parsePiText } from './pi.js'
import { loadIgnoreRules, readPatternsFile } from './ignore.js'
import { readImportState, writeImportState } from './state.js'

/** 每个用例独立的临时目录，finally 里整体清理。 */
function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-agents-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── claude：jsonl 一条 assistant 多 content block 拆多 Turn ────────

test('claude_parse_splits_blocks_into_turns', () => {
  withTempDir((dir) => {
    const file = join(dir, 'ses-demo.jsonl')
    const lines = [
      // user 纯字符串 content → 1 个 user turn
      JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我修个 bug' }, cwd: 'D:\\demo', timestamp: '2026-08-22T10:00:00Z' }),
      // assistant thinking + tool_use → 2 个 assistant turn
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [
        { type: 'thinking', thinking: '先看日志' },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ] }, cwd: 'D:\\demo', timestamp: '2026-08-22T10:00:05Z' }),
      // user tool_result → 1 个 tool turn
      JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', content: 'all pass', is_error: false },
      ] }, cwd: 'D:\\demo', timestamp: '2026-08-22T10:00:06Z' }),
      // assistant 纯文本 → 1 个 assistant turn
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [
        { type: 'text', text: '修好了' },
      ] }, cwd: 'D:\\demo', timestamp: '2026-08-22T10:00:07Z' }),
      // 坏行静默跳过
      '{not-json',
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const turns = claudeAdapter.parse(file)
    assert.equal(turns.length, 5)
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'assistant', 'tool', 'assistant'])
    assert.ok(turns[1]!.text.startsWith('[thinking] '))
    assert.equal(turns[2]!.toolName, 'Bash')
    assert.equal(turns[2]!.text, 'npm test')
    assert.equal(turns[3]!.text, 'all pass')
    assert.equal(turns[3]!.toolFailed, false)
    assert.ok(turns.every((t) => t.cwd === 'D:\\demo'))
  })
})

// ── codex：response_item 权威流，event_msg/system 跳过 ────────────

test('codex_parse_authoritative_response_items_only', () => {
  const text = [
    JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: { cwd: 'D:\\proj' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'UI 事件应跳过' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '基线噪声' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', model: 'gpt-5', content: [{ type: 'output_text', text: 'hello' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'error: boom' } }),
  ].join('\n')

  const turns = parseCodexText(text)
  assert.equal(turns.length, 4)
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool', 'tool'])
  assert.equal(turns[0]!.cwd, 'D:\\proj')
  assert.equal(turns[1]!.model, 'gpt-5')
  assert.equal(turns[2]!.toolName, 'shell')
  assert.equal(turns[3]!.toolFailed, true)
})

// ── opencode：三层文件树 session→message→part ─────────────────────

test('opencode_parse_three_layer_storage_tree', () => {
  withTempDir((root) => {
    const storage = root
    const sesFile = join(storage, 'session', 'pA', 'ses_1.json')
    mkdirSync(join(storage, 'session', 'pA'), { recursive: true })
    writeFileSync(sesFile, JSON.stringify({
      id: 'ses_1', directory: 'D:\\pA', title: '调试会话',
      time: { created: 1000, updated: 2000 },
    }), 'utf8')
    // 故意乱序写入，验证按 time.created 排序
    mkdirSync(join(storage, 'message', 'ses_1'), { recursive: true })
    writeFileSync(join(storage, 'message', 'ses_1', 'msg_2.json'),
      JSON.stringify({ id: 'msg_2', role: 'assistant', time: { created: 1100 } }), 'utf8')
    writeFileSync(join(storage, 'message', 'ses_1', 'msg_1.json'),
      JSON.stringify({ id: 'msg_1', role: 'user', time: { created: 1000 } }), 'utf8')
    mkdirSync(join(storage, 'part', 'msg_1'), { recursive: true })
    writeFileSync(join(storage, 'part', 'msg_1', 'prt_a.json'),
      JSON.stringify({ type: 'text', text: 'question' }), 'utf8')
    mkdirSync(join(storage, 'part', 'msg_2'), { recursive: true })
    writeFileSync(join(storage, 'part', 'msg_2', 'prt_b.json'),
      JSON.stringify({ type: 'text', text: 'answer' }), 'utf8')
    writeFileSync(join(storage, 'part', 'msg_2', 'prt_c.json'),
      JSON.stringify({ type: 'tool', tool: 'Bash', state: { status: 'error' } }), 'utf8')

    const turns = parseOpenCodeSession(sesFile, storage)
    assert.equal(turns.length, 3)
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool'])
    assert.equal(turns[0]!.cwd, 'D:\\pA')
    assert.ok(turns[0]!.ts !== '') // ms epoch → ISO
    assert.equal(turns[2]!.toolName, 'Bash')
    assert.equal(turns[2]!.toolFailed, true)
  })
})

// ── zcode：db.sqlite 三层表（readonly 打开临时库） ─────────────────

test('zcode_parse_sqlite_three_layer_tables', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'db.sqlite')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, path TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, sequence INTEGER, data TEXT);
    `)
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('s1', 'D:\\zproj', 'zcode 会话', 1000, 5000)
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 's1', 1,
      JSON.stringify({ role: 'user', time: { created: 1000 } }))
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m2', 's1', 2,
      JSON.stringify({ role: 'assistant', time: { created: 1100 } }))
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p1', 'm1', 1,
      JSON.stringify({ type: 'text', text: '帮我查这条 SQL' }))
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p2', 'm2', 1,
      JSON.stringify({ type: 'reasoning', text: '先看执行计划' }))
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p3', 'm2', 2,
      JSON.stringify({ type: 'step-start' })) // 跳过
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p4', 'm2', 3,
      JSON.stringify({ type: 'tool', tool: 'Bash', state: { status: 'error', input: { command: 'sqlite3 x' }, output: 'boom' } }))

    const turns = parseZcodeSession('s1', dbPath)
    // text(1) + reasoning 映射为 assistant(1) + tool error(1)；step-start 不计
    assert.equal(turns.length, 3)
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool'])
    assert.equal(turns[0]!.cwd, 'D:\\zproj')
    assert.ok(turns[1]!.text.includes('先看执行计划'))
    assert.equal(turns[2]!.toolName, 'Bash')
    assert.equal(turns[2]!.toolFailed, true)
    assert.ok(turns.every((t) => t.ts !== ''))
    db.close()
  })
})

// ── 两级 .hippoignore：全局 + 项目根，注释/空行忽略 ────────────────

test('ignore_global_and_project_root_rules', () => {
  withTempDir((dir) => {
    const globalDir = join(dir, 'global')
    const proj = join(dir, 'myproject')
    const other = join(dir, 'other')
    mkdirSync(globalDir); mkdirSync(proj); mkdirSync(other)
    writeFileSync(join(globalDir, '.hippoignore'), '# 注释行\n\nsecret-client\n', 'utf8')
    writeFileSync(join(proj, '.hippoignore'), 'internal-review\n', 'utf8')

    // 全局规则文件解析
    assert.deepEqual(readPatternsFile(join(globalDir, '.hippoignore')), ['secret-client'])

    const rules = loadIgnoreRules({ globalDir })
    // 全局命中标题
    assert.equal(rules.isIgnored({ title: 'fix secret-client login' }), true)
    assert.equal(rules.isIgnored({ title: '普通工作' }), false)
    // 项目根规则只作用于该项目 cwd 的会话
    assert.equal(rules.isIgnored({ cwd: proj, title: '关于 internal-review 的讨论' }), true)
    assert.equal(rules.isIgnored({ cwd: proj, title: '无关标题' }), false)
    assert.equal(rules.isIgnored({ cwd: other, title: '关于 internal-review 的讨论' }), false)
    // 缺省（无任何规则文件）不排除任何会话
    const bare = loadIgnoreRules({ globalDir: join(dir, 'nonexistent') })
    assert.equal(bare.isIgnored({ title: 'anything', cwd: join(dir, 'also-missing') }), false)
  })
})

// ── 增量导入状态：写入→读回一致；缺省目录返回空对象 ───────────────

test('import_state_roundtrip_in_injected_dir', () => {
  withTempDir((dir) => {
    assert.deepEqual(readImportState(dir), {})
    const state = { 'claude-code': { 'C:\\a\\b.jsonl': '1755800000000:1234' }, zcode: { s1: '5000' } }
    writeImportState(state, dir)
    assert.deepEqual(readImportState(dir), state)
  })
})


// ── pi：事件流 JSONL——session 事件给 cwd，message 事件出 turn ──────

test('pi_parser_extracts_session_cwd_and_messages', () => {
  withTempDir((dir) => {
    const file = join(dir, '2026-08-09T14-15-00-612Z_x.jsonl')
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'u1', cwd: 'D:\\coding\\demo' }),
      JSON.stringify({ type: 'model_change', id: 'm1', provider: 'ollama', modelId: 'qwen3.5:9b' }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'user', content: [{ type: 'text', text: '决定用 pnpm 管依赖' }] } }),
      JSON.stringify({ type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: '好，workspace 定稿' }] } }),
      JSON.stringify({ type: 'message', id: 'a3', message: { role: 'system', content: [{ type: 'text', text: '噪声' }] } }),
      'not json',
    ]
    writeFileSync(file, lines.join('\n'), 'utf8')
    const turns = parsePiText(readFileSync(file, 'utf8'))
    assert.equal(turns.length, 2)
    assert.equal(turns[0].role, 'user')
    assert.equal(turns[0].text, '决定用 pnpm 管依赖')
    assert.equal(turns[0].cwd, 'D:\\coding\\demo')
    assert.equal(turns[1].role, 'assistant')
  })
})
