// API client for the hippo HTTP backend.
//
// IMPORTANT: created_at / accessed_at / saved_at are epoch SECONDS, not ms.
// The typed helpers here multiply by 1000 when exposing to React so the rest
// of the app can use Date objects directly without remembering this footgun.

export const BASE = (window as unknown as { __HIPPO_BASE__?: string }).__HIPPO_BASE__ ?? '';  // dsh 桥接=前缀；独立 GUI=根

export type MemoryType = 'fact' | 'decision' | 'lesson' | 'preference';
export const MEMORY_TYPES: MemoryType[] = ['fact', 'decision', 'lesson', 'preference'];

export interface MemoryRecord {
  id: string;
  text: string;
  type: MemoryType;
  project: string;
  agent: string;
  created_at: number;   // epoch seconds（记忆写入时间）
  origin_ts?: number;   // 原会话时间（时间线用"事情发生的时间"；查不到则为空）
  accessed_at: number;  // epoch seconds
  strength: number;
  source_id?: string;
  source_offset?: number;
  /** 推翻链：非空=已被该 id 的新记忆取代（旧版保留，演化可查） */
  superseded_by?: string;
  /** 详情接口附加的演化链 */
  chain?: { newer?: { id: string; text: string; created_at: number }; older?: { id: string; text: string; created_at: number } };
}

export interface MemoryValueReport {
  total: number;
  used: number;
  neverUsed: number;
  topUsed: Array<{ id: string; text: string; type: string; project: string; strength: number; lastAccessed: number; ageDays: number }>;
  retireCandidates: Array<{ id: string; text: string; type: string; project: string; ageDays: number }>;
}

export interface AutoDistillSettings {
  mode: 'off' | 'review' | 'auto';
  threshold: number;
  intervalMin: number;
  agents: string[];
  blockDirs: string[];
  minTurns: number;
  lastRunAt?: number;
  lastRun?: { scanned: number; created: number; reinforced: number; superseded: number; shelved: number; skipped: number; at: number };
}

export interface ShelvedItem {
  index: number;
  sessionId: string;
  sourceId: string;
  reason: string;
  createdAt: number;
  candidate: { text: string; type: string; project: string; confidence: number; similarity: number; duplicate: string };
}

export interface RecallHit {
  id: string;
  text: string;
  type: MemoryType;
  project: string;
  agent: string;
  score: number;
  similarity: number;
  created_at?: number | null;
}

export interface Stats {
  total: number;
  byType: Record<string, number>;
  byProject: Record<string, number>;
}

export interface PatternDict {
  steps: string[];
  count: number;
  sessions: number;       // patternToDict already flattened the Set
  failures: number;
  success_rate: number;
  last_seen: number;      // epoch seconds
  score: number;
  examples: string[][];
}

export interface Candidate {
  text: string;
  type: MemoryType;
  project: string;
  confidence: number;
  source_rule: string;
  duplicate: '' | 'new' | 'reinforce' | 'maybe';
  similarity: number;
  source_offset: number;
}

export interface DistillResult {
  created: number;
  reinforced: number;
  skipped: number;
  maybe: number;
}

export interface SourceMeta {
  source_id: string;
  saved_at: number;
  project: string;
  agent: string;
  turn_count: number;
  original_turn_count: number;
  truncated: boolean;
}

/** A single turn in an L0 source transcript. */
export interface SourceTurn {
  role?: string;
  text?: string;
  cwd?: string;
  ts?: number;
  [k: string]: unknown;
}

/** Full L0 blob: metadata + the raw turn list. Backed by GET /api/sources/:id. */
export interface SourceBlob extends SourceMeta {
  turns: SourceTurn[];
}

export interface Diagnostics {
  dbExists: boolean;
  integrity: string;
  memoryCount: number;
  vectorCount: number;
  orphanVectors: number;
  orphanMemories: number;
  ftsDrift: number;
  vectorDim: number | null;
  providerDim: number | null;
  dimMismatch: boolean;
}

// ── helpers ──────────────────────────────────────

/** epoch seconds → Date. Returns an Invalid Date for null/undefined/NaN,
 * so callers must guard before using .toISOString() etc. */
export function toDate(epochSeconds: number | null | undefined): Date {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return new Date(NaN);
  return new Date(epochSeconds * 1000);
}

/** Format an epoch-seconds value as YYYY-MM-DD, or '' if unknown/invalid. */
export function toDateStr(epochSeconds: number | null | undefined): string {
  const d = toDate(epochSeconds);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function patchJSON<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function deleteJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}


// ── 会话（G2：看会话 / 提取会话 / 单会话蒸馏）─────────────

export interface SessionListItem {
  id: string;
  agent: string;
  title: string;
  cwd: string;
  project: string;
  updatedAt: number;      // ms epoch
  turnCount: number | null;
  distilled: number;      // 已蒸馏记忆数（0=未蒸馏）
}

export interface SessionTurn {
  role: 'user' | 'assistant' | 'tool' | string;
  text: string;
  toolName?: string;
  toolFailed?: boolean;
  ts?: string;
  cwd?: string;
}

export interface SessionDetail {
  session: { id: string; agent: string; title: string; project: string; cwd: string; updatedAt: number; turnCount: number };
  fromIndex: boolean;
  turns: SessionTurn[];
  distilledCount: number;
  distills: { at: number; created: number; reinforced: number; maybe: number }[];
}

export interface SessionDistillPreview {
  apply: boolean;
  scannedTurns: number;
  candidates: { text: string; type: MemoryType; confidence: number; duplicate: string }[];
  created: number; reinforced: number; skipped: number; maybe: number;
  note?: string;
}

export interface SyncStatus { synced: boolean; lastSyncAt: number; total: number; [k: string]: unknown; }


// ── 团队记忆（T2）────────────────────────────────────
export interface TeamTriage {
  promotions: { id: string; teamId: string; text: string; type: string; evidence: { member: string; text: string; sim: number }[]; createdAt: number }[];
  retirements: { entryId: string; scope: string; text: string; type: string; tier: string; reason: string; ageDays: number; strength: number }[];
  stats: { team: number; private: number; promoted: number; retired: number };
}
export interface TeamEntries { entries: { id: string; scope: string; text: string; type: string; derivedFrom: string[]; createdAt: number; strength: number; promotedFrom?: string[] }[]; retired: unknown[] }


// ── 生活流（life）────────────────────────────────────
export interface LifeResident { name: string; persona: string; state: { channels: string[]; lastSpokeAt: number; chattiness: number } }
export interface LifeChannel { id: string; topic: string; members: string[]; createdAt: number }
export interface LifeMsg { seq: number; at: number; author: { kind: string; name: string }; text: string }

// ── API surface ──────────────────────────────────

export const api = {
  stats: () => getJSON<Stats>('/api/stats'),
  lifeResidents: () => getJSON<LifeResident[]>('/api/life/residents'),
  lifeCreateResident: (name: string, persona: string, chattiness?: number) =>
    postJSON<LifeResident>('/api/life/residents', { name, persona, ...(chattiness !== undefined ? { chattiness } : {}) }),
  lifeDeleteResident: (name: string) => deleteJSON<{ deleted: boolean }>(`/api/life/residents/${encodeURIComponent(name)}`),
  lifeChannels: () => getJSON<LifeChannel[]>('/api/life/channels'),
  lifeCreateChannel: (id: string, topic: string, members: string[]) =>
    postJSON<LifeChannel>('/api/life/channels', { id, topic, members }),
  lifeMessages: (id: string, since = 0) => getJSON<LifeMsg[]>(`/api/life/channels/${encodeURIComponent(id)}/messages?since=${since}`),
  lifeSendMessage: (id: string, text: string) =>
    postJSON<LifeMsg>(`/api/life/channels/${encodeURIComponent(id)}/messages`, { text, author: { kind: 'user', name: 'user' } }),
  teamTriage: () => getJSON<TeamTriage>('/api/team/triage'),
  teamEntries: () => getJSON<TeamEntries>('/api/team/entries'),
  teamScan: () => postJSON<{ note?: string; teams?: number }>('/api/team/scan', {}),
  teamCycle: (teamId: string) => postJSON<{ decayed: unknown[]; forecastCards: unknown[]; note?: string }>('/api/team/cycle', { teamId }),
  teamPromotion: (id: string, action: 'promoted' | 'ignored' | 'kept-private', mergedText?: string) =>
    postJSON<{ ok: boolean; error?: string }>(`/api/team/promotion/${encodeURIComponent(id)}`, { action, ...(mergedText ? { mergedText } : {}) }),
  teamRetire: (id: string, action: 'retire' | 'keep', reason?: string) =>
    postJSON<{ ok: boolean; error?: string }>(`/api/team/retire/${encodeURIComponent(id)}`, { action, ...(reason ? { reason } : {}) }),

  // 会话（G2）
  listSessions: (opts: { agent?: string; project?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.agent) p.set('agent', opts.agent);
    if (opts.project) p.set('project', opts.project);
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.offset) p.set('offset', String(opts.offset));
    return getJSON<{ total: number; indexed: boolean; sessions: SessionListItem[] }>(`/api/sessions?${p}`);
  },
  searchSessions: (q: string) => getJSON<{ id: string; title: string; agent: string }[]>(`/api/sessions/search?q=${encodeURIComponent(q)}`),
  getSession: (id: string) => getJSON<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  sessionMemories: (id: string) =>
    getJSON<{ count: number; memories: MemoryRecord[] }>(`/api/sessions/${encodeURIComponent(id)}/memories`),
  sessionExportUrl: (id: string, format: 'md' | 'json') => `/api/sessions/${encodeURIComponent(id)}/export?format=${format}`,
  resumeSession: (id: string) =>
    postJSON<{ ok: boolean; command: string; via: string }>(`/api/sessions/${encodeURIComponent(id)}/resume`, {}),
  distillSession: (id: string, apply: boolean, pick?: number[]) =>
    postJSON<SessionDistillPreview>(`/api/sessions/${encodeURIComponent(id)}/distill`, { apply, ...(pick ? { pick } : {}) }),
  sessionStatus: () => getJSON<SyncStatus>('/api/sessions/status'),
  syncSessions: () => postJSON<SyncStatus>('/api/sessions/sync', {}),
  sourceSession: (memoryId: string) =>
    getJSON<{ sourceId: string; sessionId: string | null }>(`/api/memories/${encodeURIComponent(memoryId)}/source-session`),


  listMemories: (opts: { project?: string; type?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.project) p.set('project', opts.project);
    if (opts.type) p.set('type', opts.type);
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.offset) p.set('offset', String(opts.offset));
    const qs = p.toString();
    return getJSON<{ memories: MemoryRecord[]; total: number }>(`/api/memories${qs ? '?' + qs : ''}`);
  },

  getMemory: (id: string) => getJSON<MemoryRecord>(`/api/memories/${id}`),

  createMemory: (text: string, opts: { type?: MemoryType; project?: string; agent?: string } = {}) =>
    postJSON<{ status: string; id: string; strength?: number }>('/api/memories', { text, ...opts }),

  updateMemory: (id: string, fields: { text?: string; type?: MemoryType; project?: string }) =>
    patchJSON<{ status: string; id: string }>(`/api/memories/${id}`, fields),

  deleteMemory: (id: string) => deleteJSON<{ deleted: boolean }>(`/api/memories/${id}`),

  recall: (query: string, opts: { project?: string; limit?: number } = {}) =>
    postJSON<RecallHit[]>('/api/recall', { query, ...opts }),

  distillPreview: (transcript: string, project?: string) =>
    postJSON<{ turns: number; candidates: Candidate[] }>('/api/distill/preview', { transcript, project }),

  distillApply: (candidates: Candidate[], agent?: string) =>
    postJSON<DistillResult>('/api/distill/apply', { candidates, agent }),

  patterns: (opts: { top?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.top) p.set('top', String(opts.top));
    const qs = p.toString();
    return getJSON<{ scanned: number; total: number; patterns: PatternDict[] }>(`/api/patterns${qs ? '?' + qs : ''}`);
  },

  exportSkills: (dir: string, top?: number) =>
    postJSON<{ exported: string[] }>('/api/patterns/export', { dir, top }),

  sources: () => getJSON<SourceMeta[]>('/api/sources'),

  getSource: (id: string) => getJSON<SourceBlob>(`/api/sources/${encodeURIComponent(id)}`),

  graphEdges: (limit = 200, threshold = 0.7) =>
    getJSON<{ nodes: { id: string; text: string; type: string; project: string; strength: number }[]; edges: { source: string; target: string; similarity: number }[] }>(`/api/memories/graph-edges?limit=${limit}&threshold=${threshold}`),
  similar: (id: string, limit = 4) =>
    getJSON<RecallHit[]>(`/api/memories/${encodeURIComponent(id)}/similar?limit=${limit}`),

  compilePreview: (opts: { target: string; project?: string; minStrength?: number; indexMode?: boolean }) =>
    postJSON<{ memoryCount: number; preview: Record<string, string> }>('/api/compile/preview', opts),

  compile: (opts: { target: string; project?: string; minStrength?: number; outPath?: string; outDir?: string; indexMode?: boolean }) => {
    // 输出目录映射：文件型目标拼文件名（AGENTS.md/CLAUDE.md），cursor 用目录本身。
    // 修存量 bug：页面只传 outDir 时服务端不认，写入永远落默认路径。
    const FILENAMES: Record<string, string> = { 'agents-md': 'AGENTS.md', 'claude-md': 'CLAUDE.md' };
    let outPath = opts.outPath;
    if (!outPath && opts.outDir && opts.target !== 'all') {
      const dir = opts.outDir.replace(/[\/]+$/, '');
      outPath = FILENAMES[opts.target] ? `${dir}/${FILENAMES[opts.target]}` : dir;
    }
    const { outDir: _drop, ...rest } = opts;
    return postJSON<{ files: string[]; memoryCount: number }>('/api/compile', { ...rest, ...(outPath ? { outPath } : {}) });
  },

  // 自动蒸馏（AD）
  autoDistill: () => getJSON<{ settings: AutoDistillSettings; shelvedCount: number }>('/api/auto-distill'),
  autoDistillSave: (settings: Partial<AutoDistillSettings>) =>
    postJSON<{ settings: AutoDistillSettings }>('/api/auto-distill', { settings }),
  autoDistillRun: () => postJSON<{ scanned: number; created: number; reinforced: number; superseded: number; shelved: number; skipped: number; at: number }>('/api/auto-distill/run', {}),
  shelved: () => getJSON<ShelvedItem[]>('/api/shelved'),
  shelvedApply: (indices: number[]) => postJSON<{ created: number; reinforced: number; skipped: number; maybe: number }>('/api/shelved/apply', { indices }),
  shelvedDiscard: (indices: number[]) => postJSON<{ remaining: number }>('/api/shelved/discard', { indices }),

  deleteSession: (id: string, deleteSource = false) =>
    fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}${deleteSource ? '?deleteSource=true' : ''}`, { method: 'DELETE' })
      .then(r => r.json()) as Promise<{ removedIndex: boolean; ignored: boolean; sourceDeleted: boolean; note?: string }>,

  handoffPush: (sessionId: string, to?: string) =>
    postJSON<{ id: string; title: string; candidates: number; tasks: number; changed: number }>('/api/handoff/push', { sessionId, ...(to ? { to } : {}) }),
  handoffInbox: () => getJSON<{ pending: Array<{ id: string; from: { agent: string; title: string }; pushedAt: number; to: string }> }>('/api/handoff/inbox'),
  handoffLoad: (id: string) => postJSON<{ text: string }>('/api/handoff/load', { id }),

  memoryValue: () => getJSON<MemoryValueReport>('/api/memories/value'),

  doctor: () => getJSON<Diagnostics>('/api/doctor'),

  doctorRebuild: () => postJSON<{ salvaged: number; created: number; reinforced: number; skipped: number }>('/api/doctor/rebuild', {}),
};

// ── 工作区分级（G2：项目按工作区分组展示，不一次全摊开）──
/** cwd → 工作区根（盘符+一级目录；用户目录取到用户名一层）。 */
export function workspaceOf(cwd: string): string {
  if (!cwd) return '';
  const parts = cwd.replace(/[/]/g, '\\').split('\\').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length <= 2) return parts.join('\\');
  if (/^[a-z]:$/i.test(parts[0]) && parts[1].toLowerCase() === 'users') return parts.slice(0, 3).join('\\');
  return parts.slice(0, 2).join('\\');
}
