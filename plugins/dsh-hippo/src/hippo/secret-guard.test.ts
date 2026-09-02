import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findSecrets, hasSecret } from './secret-guard.js'

test('命中：各类真 key 形态', () => {
  const samples: Array<[string, string]> = [
    ['key 是 sk-IwpNbAGfhgzQ8ZgVsAE7gQYR1OxYsXn0 共 48 位', 'API key (sk-…)'],
    ['MINIMAX key: sk-cp-IwpNbAGfhgzQ8ZgVsAE7gQYR1OxYsXn0w40', 'API key (sk-…)'],
    ['AWS AKIAIOSFODNN7EXAMPLE 老example', 'AWS AccessKey'],
    ['github token ghp_abcdefghijklmnopqrstuvwxyz012345 记一下', 'GitHub token'],
    ['Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef', 'Bearer token'],
    ['-----BEGIN RSA PRIVATE KEY----- 记下来', '私钥块'],
    ['redis://admin:P@ssw0rd123@10.0.0.1:6379/0 这个连接串', '数据库连接串(含密码)'],
    ['api_key=AB12cd34ef56gh78 别丢了', '键值明文密钥'],
    ['password: "Sup3rSecret!42" 存在这', '键值明文密钥'],
  ]
  for (const [text, kind] of samples) {
    const hits = findSecrets(text)
    assert.ok(hits.length > 0, `应命中: ${text.slice(0, 30)}`)
    assert.ok(hits.some(h => h.kind === kind), `类别应含 ${kind}，got ${hits.map(h => h.kind)}`)
  }
})

test('不误伤：正常技术讨论', () => {
  const safe = [
    '密码策略：最少 8 位，含大小写数字',               // password 后无值
    'API key 应该从环境变量读取，不要硬编码',           // api key 后无值
    '用 sk- 前缀的是 openai 系 key',                  // sk- 后内容太短
    '端口是 3456，数据库在 localhost',                 // 普通事实
    '把 token 传给 setState',                        // token 后非长值
    'remember: JWT 校验用 HS256',                    // 单词出现
  ]
  for (const t of safe) assert.equal(hasSecret(t), false, `不应命中: ${t}`)
})

test('预览脱敏：不回显完整密钥', () => {
  const key = 'sk-IwpNbAGfhgzQ8ZgVsAE7gQYR1OxYsXn0'
  const hits = findSecrets(`key 是 ${key} 别丢了`)
  assert.equal(hits[0].preview.includes(key.slice(6, -2)), false, '中间段不得出现在预览')
})
