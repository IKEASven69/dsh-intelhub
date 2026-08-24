/**
 * 项目 CRUD 状态机 + deck.json 持久化（内存 fs 适配器）。
 */
import { describe, expect, it } from 'vitest'
import { createProject, deleteProject, emptyDeck, updateProject, builtinProjects } from '../src/protocol.ts'
import { DeckStore } from '../src/state.ts'

const ROOTS = ['D:/coding/knowledge-base', 'D:/coding/content', 'C:/Users/x/.dsh']
const KB = ROOTS[0]!
const CT = ROOTS[1]!

function memFs() {
  const files = new Map<string, string>()
  return {
    files,
    read: (p: string) => files.get(p) ?? null,
    writeAtomic: (p: string, c: string) => { files.set(p, c) },
  }
}

describe('project CRUD', () => {
  it('创建：归一化 + 排序；folder 必须在注册根内', () => {
    const st = emptyDeck()
    const ok = createProject(st, { name: '测试台', icon: '🧪', folder: CT + '/p1', template: 'blank' }, ROOTS)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value.project.name).toBe('测试台')
    const bad = createProject(st, { name: 'x', folder: 'E:/evil', template: 'blank' }, ROOTS)
    expect(bad.ok).toBe(false)
    const badT = createProject(st, { name: 'x', folder: CT, template: 'random' }, ROOTS)
    expect(badT.ok).toBe(false)
  })
  it('创建 name 必填；id 冲突拒绝', () => {
    const st = emptyDeck()
    expect(createProject(st, { folder: CT }, ROOTS).ok).toBe(false)
    const a = createProject(st, { id: 'dup', name: 'a', folder: CT }, ROOTS)
    expect(a.ok).toBe(true)
    const b = createProject(a.ok ? a.value.state : st, { id: 'dup', name: 'b', folder: CT }, ROOTS)
    expect(b.ok).toBe(false)
  })
  it('更新：合并语义 + 不许改 id；不存在报错', () => {
    const st = emptyDeck()
    const r = createProject(st, { id: 'p1', name: 'a', folder: CT }, ROOTS)
    if (!r.ok) throw new Error('setup')
    const u = updateProject(r.value.state, 'p1', { icon: '🚀', hidden: true }, ROOTS)
    expect(u.ok).toBe(true)
    if (u.ok) {
      const p = u.value.projects.find((x) => x.id === 'p1')!
      expect(p.icon).toBe('🚀')
      expect(p.name).toBe('a') // 未提供的字段保持
      expect(p.hidden).toBe(true)
    }
    expect(updateProject(r.value.state, 'p1', { id: 'p2' }, ROOTS).ok).toBe(false)
    expect(updateProject(r.value.state, 'ghost', { icon: 'x' }, ROOTS).ok).toBe(false)
  })
  it('删除：内置台面拒绝；普通项目删除', () => {
    const st = { ...emptyDeck(), projects: builtinProjects(KB, CT) }
    expect(deleteProject(st, 'builtin-kb').ok).toBe(false)
    const r = createProject(st, { id: 'p9', name: 'x', folder: CT }, ROOTS)
    if (!r.ok) throw new Error('setup')
    const d = deleteProject(r.value.state, 'p9')
    expect(d.ok).toBe(true)
  })
})

describe('DeckStore 持久化', () => {
  it('首载写入默认（含内置两台面）；损坏 JSON 重建；roundtrip 保持', () => {
    const fs = memFs()
    const path = 'C:/Users/x/.dsh/storages/dsh-deck.json'
    const store = new DeckStore(path, fs, () => ({ ...emptyDeck(), projects: builtinProjects(KB, CT) }))
    const s1 = store.load()
    expect(s1.projects.map((p) => p.id)).toEqual(['builtin-kb', 'builtin-media'])
    expect(fs.files.get(path)).toBeTruthy()
    const r = createProject(s1, { id: 'px', name: '新', folder: CT + '/x' }, ROOTS)
    if (!r.ok) throw new Error('setup')
    store.set(r.value.state)
    const store2 = new DeckStore(path, fs, () => emptyDeck())
    expect(store2.load().projects.some((p) => p.id === 'px')).toBe(true)
    const fs2 = memFs()
    fs2.files.set(path, '{corrupted')
    const store3 = new DeckStore(path, fs2, () => ({ ...emptyDeck(), projects: builtinProjects(KB, CT) }))
    expect(store3.load().version).toBe(1)
  })
})
