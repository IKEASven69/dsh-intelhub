/** D4 内容层单测：扫描/建项去重/三形态模板/状态流转。 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { ACCEPTANCE_BY_TYPE, appendPublishRow, buildPrefillText, createContent, listContent, setContentStatus, templateFiles, type ContentFs, type ContentType } from '../src/content.ts'

function memFs(files: Map<string, string>, dirs: Set<string> = new Set()): ContentFs {
  return {
    list: (dir) => {
      const out = new Set<string>()
      const p = dir.replace(/\\/g, '/')
      for (const f of files.keys()) {
        const nf = f.replace(/\\/g, '/')
        if (nf.startsWith(p + '/')) out.add(nf.slice(p.length + 1).split('/')[0]!)
      }
      for (const d of dirs) {
        const nd = d.replace(/\\/g, '/')
        if (nd.startsWith(p + '/')) out.add(nd.slice(p.length + 1).split('/')[0]!)
      }
      return [...out]
    },
    isDir: (p) => dirs.has(p),
    read: (p) => files.get(p) ?? null,
    write: (p, c) => { files.set(p, c); let cur = p; while (true) { cur = cur.slice(0, Math.max(cur.lastIndexOf('/'), cur.lastIndexOf('\\'))); if (cur === '' || cur.endsWith(':')) break; dirs.add(cur) } },
    mkdirs: (p) => { dirs.add(p) },
    exists: (p) => files.has(p),
  }
}

const ROOT = 'C:/content'

describe('createContent + listContent', () => {
  it('三形态各自带模板 + 素材/ + 发布记录；扫描回读', () => {
    const fs = memFs(new Map())
    const a = createContent(fs, ROOT, { title: '测试：文章一篇', type: 'article' }, new Date('2026-08-26T09:00:00Z'))
    expect(a.slug).toBe('测试文章一篇')
    expect(a.status).toBe('idea')
    const v = createContent(fs, ROOT, { title: '视频选题', type: 'video' }, new Date('2026-08-26T09:01:00Z'))
    const p = createContent(fs, ROOT, { title: 'PPT 选题', type: 'ppt' }, new Date('2026-08-26T09:02:00Z'))
    const items = listContent(fs, ROOT)
    expect(items).toHaveLength(3)
    const files = fs.list(join(ROOT, 'PPT-选题')).sort()
    expect(files).toContain('meta.md')
    expect(files).toContain('选题.md')
    expect(files).toContain('PPT.md')
    expect(files).toContain('发布记录.md')
    expect(fs.list(join(ROOT, '视频选题'))).toContain('脚本.md')
    expect(fs.list(join(ROOT, '视频选题'))).toContain('分镜.md')
    expect(fs.list(join(ROOT, '测试文章一篇'))).toContain('草稿.md')
    expect(v.type).toBe('video')
    expect(p.type).toBe('ppt')
  })

  it('同题 slug 去重（-2）；标题回退 选题.md H1', () => {
    const fs = memFs(new Map())
    createContent(fs, ROOT, { title: '撞题', type: 'article' }, new Date())
    const b = createContent(fs, ROOT, { title: '撞题', type: 'article' }, new Date())
    expect(b.slug).toBe('撞题-2')
    expect(listContent(fs, ROOT)).toHaveLength(2)
    // meta 无 title 字段时回退选题 H1
    fs.write(join(ROOT, 'x/meta.md'), '---\nstatus: idea\ntype: article\ncreated: 2026-01-01\n---\n\n# x\n')
    fs.write(join(ROOT, 'x/选题.md'), '# 从选题拿到的标题\n')
    const item = listContent(fs, ROOT).find((i) => i.slug === 'x')
    expect(item!.title).toBe('从选题拿到的标题')
  })

  it('空标题报错；非法 slug 拒绝（状态流转）', () => {
    const fs = memFs(new Map())
    expect(() => createContent(fs, ROOT, { title: '  ', type: 'article' }, new Date())).toThrow('标题必填')
    expect(setContentStatus(fs, ROOT, '../escape', 'ready')).toBeNull()
    expect(setContentStatus(fs, ROOT, 'nope', 'ready')).toBeNull()
  })
})

describe('状态流转 + 模板完整性', () => {
  it('idea→drafting→ready 写回 meta；列表反映', () => {
    const fs = memFs(new Map())
    createContent(fs, ROOT, { title: '流转测试', type: 'ppt' }, new Date('2026-08-26T10:00:00Z'))
    const next = setContentStatus(fs, ROOT, '流转测试', 'drafting')
    expect(next!.status).toBe('drafting')
    expect(setContentStatus(fs, ROOT, '流转测试', 'ready')!.status).toBe('ready')
    expect(listContent(fs, ROOT)[0]!.status).toBe('ready')
  })
  it('三形态验收条目齐备（交给 zcode 的默认 acceptance）', () => {
    for (const t of ['article', 'video', 'ppt'] as ContentType[]) {
      expect(ACCEPTANCE_BY_TYPE[t].length).toBeGreaterThanOrEqual(3)
      expect(Object.keys(templateFiles(t, 'T')).length).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('D5 发布预填', () => {
  it('buildPrefillText 取形态正文、去 md 记号、超限截断', () => {
    const fs = memFs(new Map())
    const item = createContent(fs, ROOT, { title: '测试选题', type: 'article' }, new Date('2026-08-26T11:00:00Z'))
    fs.write(join(ROOT, item.slug, '草稿.md'), '# 测试选题\n\n**加粗**和`代码`——正文内容若干。'.repeat(30))
    const t = buildPrefillText(fs, ROOT, item, 120)
    expect(t.startsWith('测试选题：')).toBe(true)
    expect(t.length).toBeLessThanOrEqual(120)
    expect(t).not.toContain('#')
    expect(t).not.toContain('**')
  })
  it('appendPublishRow 表格追加 + 非法 slug 拒绝', () => {
    const fs = memFs(new Map())
    const item = createContent(fs, ROOT, { title: '记录测试', type: 'video' }, new Date('2026-08-26T12:00:00Z'))
    expect(appendPublishRow(fs, ROOT, item.slug, { date: '2026-08-26', platform: '微博', result: '预填（未发）', note: 'x' })).toBe(true)
    const raw = fs.read(join(ROOT, item.slug, '发布记录.md'))!
    expect(raw.trimEnd().endsWith('| 2026-08-26 | 微博 | 预填（未发） | x |')).toBe(true)
    expect(appendPublishRow(fs, ROOT, '../escape', { date: 'd', platform: 'p', result: 'r', note: 'n' })).toBe(false)
  })
})
