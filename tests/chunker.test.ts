/** 分块器单测:边界、长度约束、CRLF、超长段落、空输入。 */
import { describe, expect, it } from 'vitest'
import { chunkText, DEFAULT_MAX_CHUNK } from '../src/chunker.ts'

describe('chunkText', () => {
  it('空与纯空白返回空数组', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('  \n \n ')).toEqual([])
  })

  it('按空行分段并合并到 maxLen 内', () => {
    const paras = ['第一段内容'.repeat(5), '第二段内容'.repeat(5), '第三段内容'.repeat(5)]
    const chunks = chunkText(paras.join('\n\n'), 200)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200)
    // 三段总长 < 200 应合并成一块
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('第一段')
    expect(chunks[0]).toContain('第三段')
  })

  it('超长段落硬切且每块不超 maxLen', () => {
    const long = '甲'.repeat(1000)
    const chunks = chunkText(long, 120)
    expect(chunks.length).toBeGreaterThanOrEqual(9)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120)
    expect(chunks.join('')).toBe(long)
  })

  it('markdown 标题行成为边界', () => {
    const md = '## 安装\nnpm i 之后运行。\n\n## 用法\n直接调用即可,无需配置。'
    const chunks = chunkText(md, 400)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toContain('安装')
    expect(chunks[1]).toContain('用法')
  })

  it('短段合并进相邻块;无法合并的碎屑被丢弃', () => {
    // 能合并:短段并入相邻块,内容不丢
    const merged = chunkText('短。\n\n这是足够长的一段内容,可以成为独立块,不会被视为碎屑丢弃掉。', 400)
    expect(merged.length).toBe(1)
    expect(merged[0]).toContain('短。')
    // 不能合并(顶到 maxLen 边界):碎屑被丢弃
    const thirty = '甲'.repeat(30)
    const dropped = chunkText(thirty + '\n\n短。', 30)
    expect(dropped).toEqual([thirty])
  })

  it('CRLF 归一化', () => {
    const chunks = chunkText('第一行内容\r\n\r\n第二行内容,加长一点确保不被当作碎屑。', 400)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).not.toContain('\r')
  })

  it('默认 maxLen 下常规段落不超限', () => {
    const text = Array.from({ length: 30 }, (_, i) => `第${i}条记录,这是一段中等长度的内容,用于验证默认上限。`).join('\n\n')
    for (const c of chunkText(text)) expect(c.length).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK)
  })
})
