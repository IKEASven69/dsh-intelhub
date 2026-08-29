/**
 * 会话适配器统一类型：所有 agent 的会话统一为 SessionRef（发现层）+
 * Turn 流（解析层）。GUI 会话浏览、distill 蒸馏、dsh 插件 import 三个消费者共用。
 */
import type { Turn } from '../patterns/transcript.js'

/** 一个已发现的会话（发现层产物，轻量：不含内容）。 */
export interface SessionRef {
  /** 归属适配器名：claude-code | codex | opencode | zcode | … */
  agent: string
  /** 稳定 id：文件系=绝对路径；SQLite 系=会话 id。 */
  id: string
  title: string
  cwd: string
  /** 最近更新时间（ms epoch），GUI 排序用。 */
  updatedAt: number
  /** 增量指纹：文件系="mtime:size"；SQLite 系=String(time_updated)。变更即需重蒸馏。 */
  fingerprint: string
  kind: 'file' | 'sqlite'
}

/** 一个 agent 的会话发现结果（inventory）。 */
export interface AgentInventory {
  agent: string
  root: string
  sessions: number
  supported: boolean
  note?: string
}

/** 会话适配器：发现 + 解析两段。 */
export interface SessionAdapter {
  readonly name: string
  readonly root: string
  readonly supported: boolean
  note?: string
  /** 发现本机全部会话（轻量，不读内容主体；zcode 只查 session 表元数据）。 */
  discover(): SessionRef[]
  /** 解析一个会话为 Turn 流。id 必须来自 discover()。 */
  parse(id: string): Turn[]
}

/** .hippoignore 排除规则。 */
export interface IgnoreRules {
  /** 规则原文（每行一个子串，# 注释）。 */
  patterns: string[]
  /** 命中即排除：匹配会话标题 / 项目名 / cwd / id。 */
  isIgnored(ref: { title?: string; cwd?: string; agent?: string; id?: string; project?: string }): boolean
}

/** 增量导入状态：<dataDir>/import-state.json。 */
export interface ImportState {
  /** agent → { id → fingerprint }；fingerprint 不变即跳过。 */
  [agent: string]: Record<string, string>
}
