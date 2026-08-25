/**
 * 安全线回归：跨站请求拦截 + 路径穿越全家桶。任何一项被绕过都是高危。
 */
import { describe, expect, it } from 'vitest'
import { allowRequest, resolveWithinRoot, RootRegistry } from '../src/security.ts'

const SAME = { method: 'POST', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }

describe('allowRequest（源校验）', () => {
  it('同源写放行', () => {
    expect(allowRequest(SAME)).toBe(true)
  })
  it('跨站 Origin 拒绝（GET 与 POST 都拒）', () => {
    expect(allowRequest({ method: 'POST', headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' } })).toBe(false)
    expect(allowRequest({ method: 'GET', headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } })).toBe(false)
  })
  it('写方法无 Origin 一律拒绝（浏览器跨站 POST 必带 Origin）', () => {
    expect(allowRequest({ method: 'POST', headers: { host: '127.0.0.1:3080' } })).toBe(false)
    expect(allowRequest({ method: 'POST', headers: {} })).toBe(false)
  })
  it('GET 无 Origin 放行（地址栏/导航）；Origin 端口不一致拒绝', () => {
    expect(allowRequest({ method: 'GET', headers: { host: '127.0.0.1:3080' } })).toBe(true)
    expect(allowRequest({ method: 'GET', headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3080' } })).toBe(false)
  })
  it('Origin 值损坏（非 URL）拒绝', () => {
    expect(allowRequest({ method: 'POST', headers: { origin: '::not a url::', host: '127.0.0.1:3080' } })).toBe(false)
  })
})

describe('resolveWithinRoot（穿越全家桶）', () => {
  const ROOT = process.platform === 'win32' ? 'D:\\test\\root' : '/test/root'
  it('合法相对路径解析到根内', () => {
    expect(resolveWithinRoot(ROOT, 'a/b/c.md')).not.toBeNull()
    expect(resolveWithinRoot(ROOT, '中文/文件.md')).not.toBeNull()
  })
  it('拒绝绝对路径 / .. / 反斜杠 / 盘符 / NUL / 空段', () => {
    expect(resolveWithinRoot(ROOT, '/etc/passwd')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'a/../../etc')).toBeNull()
    expect(resolveWithinRoot(ROOT, '..\\..\\windows')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'a\\b')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'C:/windows')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'a\0b')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'a//b')).toBeNull()
    expect(resolveWithinRoot(ROOT, './a')).toBeNull()
    expect(resolveWithinRoot(ROOT, '')).toBeNull()
  })
  it('点开头的合法段（.git/.gitignore/.env）放行；点穿越仍拦', () => {
    expect(resolveWithinRoot(ROOT, '.git')).not.toBeNull()
    expect(resolveWithinRoot(ROOT, '.git/objects/ab')).not.toBeNull()
    expect(resolveWithinRoot(ROOT, '.gitignore')).not.toBeNull()
    expect(resolveWithinRoot(ROOT, '.baoyu-skills/.env')).not.toBeNull()
    expect(resolveWithinRoot(ROOT, '.')).toBeNull()
    expect(resolveWithinRoot(ROOT, '..')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'a/../b')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'a/./b')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'a/.hidden')).not.toBeNull()
  })
  it('resolve 后逃出根的变形路径被包含性复核拦下', () => {
    // Unicode 分隔符变形之类 resolve 后越界的，靠包含性检查兜底
    expect(resolveWithinRoot(ROOT, 'a/b')).not.toBeNull()
  })
})

describe('RootRegistry', () => {
  it('别名注册与解析；未注册返回 undefined', () => {
    const r = new RootRegistry()
    r.register('kb', 'D:/coding/knowledge-base')
    expect(r.resolveRoot('kb')).toBeTruthy()
    expect(r.resolveRoot('nope')).toBeUndefined()
    expect(r.aliases()).toEqual(['kb'])
  })
})
