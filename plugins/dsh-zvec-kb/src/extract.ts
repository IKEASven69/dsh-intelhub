/**
 * 文件抽取:文本族直接读;PDF 用 pdfjs-dist(进程内,无系统依赖);docx 用 mammoth。
 * 单文件失败不阻断整批导入(返回 null + 原因由调用方记录)。
 * @module dsh-zvec-kb
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** 支持导入的扩展名(小写)。 */
export const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.log', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sh'])
export const PDF_EXTS = new Set(['.pdf'])
export const DOCX_EXTS = new Set(['.docx'])
export const SUPPORTED_EXTS = new Set([...TEXT_EXTS, ...PDF_EXTS, ...DOCX_EXTS])

/** 单文件原始大小上限(字节),防御性截流。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

/** 抽取结果:null 表示不支持/失败,reason 供注册表 error 字段。 */
export async function extractText(path: string): Promise<{ text: string | null; reason?: string }> {
  const ext = extname(path).toLowerCase()
  try {
    if (TEXT_EXTS.has(ext)) {
      const raw = await readFile(path, 'utf8')
      return { text: raw.replace(/\u0000/g, '').trim() || null, reason: '空文件' }
    }
    if (PDF_EXTS.has(ext)) {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const doc = await pdfjs.getDocument({ data: await readFile(path), useSystemFonts: true }).promise
      const parts: string[] = []
      const pages = Math.min(doc.numPages, 500)
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '))
      }
      const text = parts.join('\n\n').replace(/\u0000/g, '').trim()
      return text ? { text } : { text: null, reason: 'PDF 无可抽取文本(可能为扫描件)' }
    }
    if (DOCX_EXTS.has(ext)) {
      const mammoth = await import('mammoth')
      const { value } = await mammoth.extractRawText({ path })
      return { text: value.trim() || null, reason: '空文档' }
    }
    return { text: null, reason: `不支持的扩展名 ${ext}` }
  } catch (err: unknown) {
    return { text: null, reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) }
  }
}
