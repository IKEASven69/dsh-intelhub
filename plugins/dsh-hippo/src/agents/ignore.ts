/**
 * .hippoignore 隐私排除：全局 <dataDir>/.hippoignore + 各项目根 .hippoignore 两级。
 * 每行一个子串，命中会话标题/项目名/cwd/agent/id 即跳过蒸馏；# 开头为注释。
 * 空文件/缺省=全量。项目规则按 ref.cwd 定位并按目录缓存（进程内只读一次盘）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../hippo/store.js'
import type { IgnoreRules } from './types.js'

/** 读单个 .hippoignore 的有效规则；文件不存在/读失败返回 []。 */
export function readPatternsFile(path: string): string[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
  } catch {
    return []
  }
}

/** 子串匹配：任一规则命中任一非空字段即排除。 */
function matchAny(patterns: string[], hay: string[]): boolean {
  if (patterns.length === 0) return false
  const fields = hay.filter((h) => h !== '')
  return patterns.some((p) => fields.some((f) => f.includes(p)))
}

// 项目根规则缓存：同一 cwd 的会话批量导入时避免反复读盘
const projectCache = new Map<string, string[]>()

function projectPatterns(cwd: string): string[] {
  if (cwd === '') return []
  let rules = projectCache.get(cwd)
  if (rules === undefined) {
    rules = readPatternsFile(join(cwd, '.hippoignore'))
    projectCache.set(cwd, rules)
  }
  return rules
}

/**
 * 两级规则：全局(~/.hippo/.hippoignore) + 会话所属项目根(.hippoignore)，语义一致。
 * globalDir 可注入（单测用），缺省 ~/.hippo。
 */
export function loadIgnoreRules(opts?: { globalDir?: string }): IgnoreRules {
  const globalRules = readPatternsFile(join(opts?.globalDir ?? dataDir(), '.hippoignore'))
  return {
    patterns: globalRules,
    isIgnored(ref) {
      const hay = [ref.title ?? '', ref.cwd ?? '', ref.project ?? '', ref.agent ?? '', ref.id ?? '']
      if (matchAny(globalRules, hay)) return true
      // 项目根规则只作用于该项目自己的会话
      return matchAny(projectPatterns(ref.cwd ?? ''), hay)
    },
  }
}
