/**
 * deck.json 持久化：~/.dsh/storages/dsh-deck.json（host 路由通道，绕 agent 沙箱）。
 * 原子写（tmp+rename）；fs 适配器可注入（单测用内存实现）。
 * @module dsh-deck/state
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { builtinProjects, emptyDeck, type DeckState } from './protocol.ts'

export interface FsAdapter {
  read(path: string): string | null
  writeAtomic(path: string, content: string): void
}

export const nodeFs: FsAdapter = {
  read(path) {
    try { return readFileSync(path, 'utf8') } catch { return null }
  },
  writeAtomic(path, content) {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
  },
}

export class DeckStore {
  private state: DeckState | null = null

  constructor(
    private readonly path: string,
    private readonly fs: FsAdapter,
    private readonly defaults: () => DeckState,
  ) {}

  load(): DeckState {
    if (this.state !== null) return this.state
    const raw = this.fs.read(this.path)
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as DeckState
        if (parsed && parsed.version === 1 && Array.isArray(parsed.projects)) {
          this.state = parsed
          return this.state
        }
      } catch { /* 损坏则重建 */ }
    }
    this.state = this.defaults()
    this.save()
    return this.state
  }

  save(): void {
    if (this.state === null) return
    this.fs.writeAtomic(this.path, JSON.stringify(this.state, null, 2) + '\n')
  }

  get(): DeckState {
    return this.load()
  }

  set(next: DeckState): void {
    this.state = next
    this.save()
  }
}

export function deckPath(dshHome: string): string {
  return dshHome + '/storages/dsh-deck.json'
}

export function deckDefaults(kbRoot: string, mediaRoot: string): () => DeckState {
  return () => ({ ...emptyDeck(), projects: builtinProjects(kbRoot, mediaRoot) })
}
