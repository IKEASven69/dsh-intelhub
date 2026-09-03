import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { openSessionIndex, searchSessionsHybrid, sessionSummaryText, setSessionEmbedder } from './session-index.js'
import type { Turn } from '../patterns/transcript.js'
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-sidx-'))

// 嵌入桩：确定性伪向量——按关键词表映射，"向量库/qdrant" vs "UI/样式" 两个语义簇
const CLUSTERS: Array<[RegExp, number[]]> = [
  [/向量|qdrant|milvus|选型/, [1, 0.9, 0, 0]],
  [/UI|样式|按钮|布局/, [0, 0, 1, 0.9]],
]

/** 直写一个会话 + 单轮（绕过适配器，纯夹具）。 */
function seedSession(id: string, cwd: string, title: string, userText: string, fingerprint: string): void {
  const db = openSessionIndex(DIR)
  try {
    db.prepare(`INSERT INTO sessions (ext_id, agent, title, cwd, project, updated_at, fingerprint, turn_count)
      VALUES (?, 'zcode', ?, ?, 'proj', strftime('%s','now'), ?, 1)`).run(id, title, cwd, fingerprint)
    db.prepare("INSERT INTO turns (session_id, seq, role, ts, text, tool_name, tool_failed) VALUES (?, 0, 'user', '', ?, '', 0)")
      .run(id, userText)
  } finally { db.close() }
}

function fakeEmbed(text: string): Promise<Float32Array> {
  const v = [0.1, 0.1, 0.1, 0.1]
  for (const [re, vec] of CLUSTERS) if (re.test(text)) for (let i = 0; i < vec.length; i++) v[i] += vec[i]
  return Promise.resolve(new Float32Array(v))
}
setSessionEmbedder(fakeEmbed)

test('hybrid: 语义命中（关键字搜不到的会话）', async () => {
  seedSession('sess-vec', 'D:/proj', '前端改动', '把按钮改成圆角，样式统一走主题变量', 'fp1')
  seedSession('sess-db', 'D:/proj', '存储选型', '对比了 qdrant 和 milvus，向量库选型定了 qdrant', 'fp2')

  const hits = await searchSessionsHybrid('向量库怎么选型的', { dataDir: DIR })
  assert.ok(hits.length > 0)
  // 语义第一名应是存储选型会话（关键字"向量库怎么选型"不含 qdrant 原文也能命中）
  const db = hits.find(h => h.title === '存储选型')
  assert.ok(db !== undefined, `应命中存储选型会话: ${hits.map(h => h.title)}`)
})

test('hybrid: 关键字命中不被语义淹没（RRF 融合）', async () => {
  const hits = await searchSessionsHybrid('圆角', { dataDir: DIR })
  assert.ok(hits.length > 0 && hits[0].title === '前端改动')
})

test('sessionSummaryText: 截断拼接', () => {
  const t = sessionSummaryText('标题', '正文'.repeat(300))
  assert.ok(t.startsWith('标题'))
  assert.ok(t.length <= 410)
})

test('无嵌入注入时退化为纯关键字（不抛错）', async () => {
  const mod = await import('./session-index.js')
  mod.setSessionEmbedder(null as unknown as (text: string) => Promise<Float32Array>)
  const hits = await searchSessionsHybrid('圆角', { dataDir: DIR })
  assert.ok(hits.length > 0)
  mod.setSessionEmbedder(fakeEmbed)
})
