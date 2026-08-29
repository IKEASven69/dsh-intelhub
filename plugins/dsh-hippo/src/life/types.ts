/**
 * life 共享类型：居民（常驻人格 agent）+ 频道（话题房间）+ 消息账本。
 * 存储布局（<dataDir>/life/）：
 *   residents/<name>/persona.md + state.json
 *   channels/<id>/channel.md + history.jsonl + bookmark.json
 */

export interface ResidentState {
  /** 活跃频道 id 列表。 */
  channels: string[]
  /** 最近一次发言时间（ms epoch）。 */
  lastSpokeAt: number
  /** 人格参数：点醒频率（次/小时，0=从不主动）。 */
  chattiness: number
}

export interface Resident {
  /** kebab-case 名字，目录名即身份。 */
  name: string
  /** persona.md 原文（人格设定）。 */
  persona: string
  state: ResidentState
  createdAt: number
}

export interface Channel {
  /** kebab-case id，目录名。 */
  id: string
  /** 主题一句话。 */
  topic: string
  /** 成员（居民名列表）。 */
  members: string[]
  createdAt: number
}

export type MessageAuthor =
  | { kind: 'user'; name: string }
  | { kind: 'resident'; name: string }
  | { kind: 'system'; event: string }

export interface ChannelMessage {
  /** 递增序号（账本内唯一）。 */
  seq: number
  at: number
  author: MessageAuthor
  text: string
}
