/**
 * 会话删除（用户要求补的功能）：
 * - file 类（claude/codex/opencode 的 jsonl）：默认删 hippo 索引行 + 写 .hippoignore
 *   防复活；deleteSource=true 时连源文件一起删（agent 自己的历史，需二次确认）。
 * - sqlite 类（zcode/pi）：动不了 agent 的库——只删索引行 + ignore 防复活。
 * 记忆不动：已蒸馏的记忆与 L0 溯源保留（删除会话≠遗忘知识）。
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../hippo/store.js'
import { loadIgnoreRules, readPatternsFile } from './ignore.js'
import { getIndexedSession, removeSessionRows } from './session-index.js'

const GLOBAL_IGNORE = () => join(dataDir(), '.hippoignore')

/** 幂等追加一条 ignore 规则（会话 id），防下次同步复活。 */
export function ignoreSession(sessionId: string): void {
  const file = GLOBAL_IGNORE()
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : ''
  // 已含（子串命中）则不重复写
  if (readPatternsFile(file).some((p) => sessionId.includes(p))) return
  const prefix = existing === '' ? '# hippo 会话排除（删除会话时自动写入）\n' : existing.endsWith('\n') || existing === '' ? '' : '\n'
  appendFileSync(file, `${prefix}${sessionId}\n`, 'utf-8')
  // 进程内规则缓存失效：ignore.ts 的全局缓存读取时机在 loadIgnoreRules，
  // 每次调用重读文件，无缓存问题；项目级缓存与 id 无关。
}

export interface DeleteSessionResult {
  removedIndex: boolean
  ignored: boolean
  sourceDeleted: boolean
  /** sqlite 类会话不支持删源文件时的说明 */
  note?: string
}

/** 删除一个会话：索引行 + ignore；file 类可选删源文件。 */
export function deleteSession(sessionId: string, opts: { deleteSource?: boolean } = {}): DeleteSessionResult {
  const meta = getIndexedSession(sessionId)
  const result: DeleteSessionResult = { removedIndex: false, ignored: false, sourceDeleted: false }

  // 1) ignore 防复活（无论哪种类型）
  const rules = loadIgnoreRules()
  if (!rules.isIgnored({ id: sessionId })) {
    ignoreSession(sessionId)
    result.ignored = true
  }

  // 2) 删源文件（仅 file 类且显式要求）
  if (opts.deleteSource === true) {
    const isFileKind = sessionId.endsWith('.jsonl') || sessionId.endsWith('.jsonl.zstd')
    if (isFileKind && existsSync(sessionId)) {
      try {
        rmSync(sessionId, { force: true })
        result.sourceDeleted = true
      } catch { /* 权限等失败不阻断索引删除 */ }
    } else {
      result.note = 'SQLite 类会话（zcode/pi）不动 agent 数据库，仅从 hippo 移除。'
    }
  }

  // 3) 删索引行（sessions + turns 级联；session_distills 保留作"已处理"标记无妨——
  //    ignore 在导入前生效，不会再进 sessions 表）
  result.removedIndex = removeSessionRows(sessionId)

  void meta
  return result
}
