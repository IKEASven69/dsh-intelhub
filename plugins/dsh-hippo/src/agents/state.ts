/**
 * 增量导入状态：<dataDir>/import-state.json。
 * { agent: { 会话id: 指纹 } }——指纹不变即跳过；删文件=强制全量。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../hippo/store.js'
import type { ImportState } from './types.js'

/** dir 可注入（单测用临时目录），缺省 ~/.hippo。 */
export function readImportState(dir: string = dataDir()): ImportState {
  const path = join(dir, 'import-state.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ImportState
  } catch {
    return {}
  }
}

export function writeImportState(state: ImportState, dir: string = dataDir()): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'import-state.json'), JSON.stringify(state, null, 1), 'utf8')
}
