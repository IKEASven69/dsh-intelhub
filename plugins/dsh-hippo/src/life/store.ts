/**
 * life 存储：居民/频道/账本/游标 CRUD。
 * 目录布局即模型（Agent 即文件夹，openhanako 验证）；history.jsonl 是
 * append-only 真相源；bookmark 是每居民游标（读到哪个 seq）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Channel, ChannelMessage, Resident, ResidentState } from './types.js'

const LIFE_DIR = join(process.env.HIPPO_DATA_DIR ?? join(homedir(), '.hippo'), 'life')
const RESIDENTS = join(LIFE_DIR, 'residents')
const CHANNELS = join(LIFE_DIR, 'channels')

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

function lifeDir(): string {
  mkdirSync(RESIDENTS, { recursive: true })
  mkdirSync(CHANNELS, { recursive: true })
  return LIFE_DIR
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

// ── 居民 ─────────────────────────────────────────────

export function createResident(name: string, persona: string, opts: { chattiness?: number } = {}): Resident {
  if (!NAME_RE.test(name)) throw new Error(`居民名须为 kebab-case（a-z0-9-，≤32 字符）：${name}`)
  lifeDir()
  const dir = join(RESIDENTS, name)
  if (existsSync(dir)) throw new Error(`居民已存在：${name}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'persona.md'), persona, 'utf8')
  const state: ResidentState = { channels: [], lastSpokeAt: 0, chattiness: Math.max(0, Math.min(opts.chattiness ?? 1, 10)) }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 1), 'utf8')
  return { name, persona, state, createdAt: Date.now() }
}

export function listResidents(): Resident[] {
  lifeDir()
  const out: Resident[] = []
  for (const d of readdirSync(RESIDENTS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = join(RESIDENTS, d.name)
    let persona = ''
    try { persona = readFileSync(join(dir, 'persona.md'), 'utf8') } catch { persona = '' }
    out.push({ name: d.name, persona, state: readJson<ResidentState>(join(dir, 'state.json'), { channels: [], lastSpokeAt: 0, chattiness: 1 }), createdAt: 0 })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function getResident(name: string): Resident | null {
  if (!NAME_RE.test(name)) return null
  const dir = join(RESIDENTS, name)
  if (!existsSync(dir)) return null
  let persona = ''
  try { persona = readFileSync(join(dir, 'persona.md'), 'utf8') } catch { persona = '' }
  return { name, persona, state: readJson<ResidentState>(join(dir, 'state.json'), { channels: [], lastSpokeAt: 0, chattiness: 1 }), createdAt: 0 }
}

export function deleteResident(name: string): boolean {
  if (!NAME_RE.test(name)) return false
  const dir = join(RESIDENTS, name)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** 居民加入/离开频道（同步 state.json 与 channel.md 成员表由频道侧完成）。 */
export function residentJoinChannel(name: string, channelId: string): void {
  const r = getResident(name)
  if (r === null) throw new Error(`居民不存在：${name}`)
  if (!r.state.channels.includes(channelId)) {
    r.state.channels.push(channelId)
    writeFileSync(join(RESIDENTS, name, 'state.json'), JSON.stringify(r.state, null, 1), 'utf8')
  }
}

// ── 频道 ─────────────────────────────────────────────

export function createChannel(id: string, topic: string, members: string[]): Channel {
  if (!NAME_RE.test(id)) throw new Error(`频道 id 须为 kebab-case：${id}`)
  lifeDir()
  const dir = join(CHANNELS, id)
  if (existsSync(dir)) throw new Error(`频道已存在：${id}`)
  mkdirSync(dir, { recursive: true })
  const ch: Channel = { id, topic, members: [...new Set(members)], createdAt: Date.now() }
  writeFileSync(join(dir, 'channel.md'), renderChannelMd(ch), 'utf8')
  writeFileSync(join(dir, 'channel.json'), JSON.stringify(ch, null, 1), 'utf8')
  writeFileSync(join(dir, 'history.jsonl'), '', 'utf8')
  for (const m of ch.members) {
    try { residentJoinChannel(m, id) } catch { /* 成员不存在不阻塞建频道 */ }
  }
  return ch
}

function renderChannelMd(ch: Channel): string {
  return `# ${ch.id}\n\n- 主题：${ch.topic}\n- 成员：${ch.members.join('、') || '（空）'}\n- 创建：${new Date(ch.createdAt).toISOString()}\n\n> 本文件是可再生投影（真相源=history.jsonl）。\n`
}

export function listChannels(): Channel[] {
  lifeDir()
  const out: Channel[] = []
  for (const d of readdirSync(CHANNELS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = join(CHANNELS, d.name)
    const ch = readJson<Partial<Channel>>(join(dir, 'channel.json'), {})
    // channel.md 为投影；元数据以 channel.json 为准（若 md-only 则从 md 读不到，补 json 写入）
    if (ch.id === undefined) {
      const meta: Channel = { id: d.name, topic: ch.topic ?? '', members: ch.members ?? [], createdAt: ch.createdAt ?? 0 }
      writeFileSync(join(dir, 'channel.json'), JSON.stringify(meta, null, 1), 'utf8')
      out.push(meta)
    } else {
      out.push(ch as Channel)
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function getChannel(id: string): Channel | null {
  if (!NAME_RE.test(id)) return null
  const dir = join(CHANNELS, id)
  if (!existsSync(dir)) return null
  return readJson<Channel>(join(dir, 'channel.json'), { id, topic: '', members: [], createdAt: 0 })
}

/** 删除频道（目录整体移除；居民不受影响，仅失去该频道的消息历史）。 */
export function deleteChannel(id: string): boolean {
  if (!NAME_RE.test(id)) return false
  const dir = join(CHANNELS, id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

// ── 消息账本 + 游标 ──────────────────────────────────

export function appendMessage(channelId: string, author: ChannelMessage['author'], text: string): ChannelMessage {
  const dir = join(CHANNELS, channelId)
  if (!existsSync(dir)) throw new Error(`频道不存在：${channelId}`)
  const seq = nextSeq(dir)
  const msg: ChannelMessage = { seq, at: Date.now(), author, text }
  appendFileSync(join(dir, 'history.jsonl'), JSON.stringify(msg) + '\n', 'utf8')
  return msg
}

export function readMessages(channelId: string, sinceSeq = 0, limit = 200): ChannelMessage[] {
  const dir = join(CHANNELS, channelId)
  const file = join(dir, 'history.jsonl')
  if (!existsSync(file)) return []
  const out: ChannelMessage[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      const m = JSON.parse(t) as ChannelMessage
      if (m.seq > sinceSeq) out.push(m)
    } catch { continue }
  }
  return out.slice(-limit)
}

/** 每居民游标：读到哪个 seq（token 经济——没读的不进上下文）。 */
export function readBookmark(channelId: string, residentName: string): number {
  const file = join(CHANNELS, channelId, 'bookmark.json')
  return readJson<Record<string, number>>(file, {})[residentName] ?? 0
}

export function writeBookmark(channelId: string, residentName: string, seq: number): void {
  const file = join(CHANNELS, channelId, 'bookmark.json')
  const all = readJson<Record<string, number>>(file, {})
  all[residentName] = seq
  writeFileSync(file, JSON.stringify(all, null, 1), 'utf8')
}

function nextSeq(dir: string): number {
  let max = 0
  const file = join(dir, 'history.jsonl')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim()
      if (t === '') continue
      try { max = Math.max(max, (JSON.parse(t) as ChannelMessage).seq) } catch { continue }
    }
  }
  return max + 1
}
