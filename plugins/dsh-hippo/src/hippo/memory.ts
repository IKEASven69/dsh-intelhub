/**
 * Memory semantics: what to keep, how to merge, how to rank recall.
 * TS port of hippo memory.py, line-equivalent in behavior.
 *
 * This layer is storage-agnostic. A Store must provide:
 *   upsert(record, vector)
 *   search(vector, projects, limit) -> [record, similarity][]
 *   get(id) -> [record, vector] | null
 *   delete(id) -> boolean
 *   touch(id, { accessedAt, strength? })
 * and optionally hybridSearch(queryText, vector, projects, limit).
 *
 * Unlike the Python original there is no threading.RLock: embed() is async
 * here, so a promise-chain mutex guards the read-modify-write sequences
 * (remember's search→touch dedup path) against interleaved callers.
 */
import crypto from 'node:crypto';

// Dedup bands. The original 0.92/0.75 values were tuned on bge-small-zh;
// bge-m3 has a much higher similarity baseline (unrelated pairs median
// ~0.74), so the constants were recalibrated on 20k real messages — see
// docs/threshold-calibration.md.
export const DEDUP_THRESHOLD = 0.93;
export const RECENCY_HALF_LIFE_DAYS = 90.0;
export const GLOBAL_PROJECT = 'global';
export const VALID_TYPES = ['fact', 'decision', 'lesson', 'preference'] as const;
export type MemoryType = (typeof VALID_TYPES)[number];

/** A stored memory row. Field names stay snake_case to match the hippo
 * export JSONL format (migration path: hippo export -> import). */
export interface MemoryRecord {
  id: string;
  text: string;
  type: string;
  project: string;
  agent: string;
  created_at: number;
  accessed_at: number;
  strength: number;
  /** L1→L0 provenance: '' for hand-written memories; distill fills it. */
  source_id: string;
  source_offset: number; // -1 when none
  /** 轻量双时态（推翻链）：非空=已被该 id 的新记忆取代；保留不删，演化可查。 */
  superseded_by?: string;
}

export type SearchHit = [record: MemoryRecord, similarity: number];

export interface Store {
  upsert(record: MemoryRecord, vector: Float32Array): Promise<void>;
  search(vector: Float32Array, projects: string[], limit: number): Promise<SearchHit[]>;
  get(memoryId: string): Promise<[MemoryRecord, Float32Array] | null>;
  delete(memoryId: string): Promise<boolean>;
  touch(memoryId: string, opts: { accessedAt: number; strength?: number }): Promise<void>;
  /** Optional: BM25+vector RRF fusion. recall() uses it when present. */
  hybridSearch?(
    queryText: string,
    vector: Float32Array,
    projects: string[],
    limit: number,
  ): Promise<SearchHit[]>;
}

export type EmbedFn = (text: string) => Promise<Float32Array>;

export interface RememberResult {
  status: 'created' | 'reinforced';
  id: string;
  strength?: number;
}

export interface RecallHit {
  id: string;
  text: string;
  type: string;
  project: string;
  agent: string;
  score: number;
  similarity: number;
}

export class MemoryEngine {
  private _store: Store;
  private _embed: EmbedFn;
  private _queue: Promise<unknown> = Promise.resolve();

  constructor(store: Store, embed: EmbedFn) {
    this._store = store;
    this._embed = embed;
  }

  /** Exposed for distill's classify pass (embeds candidates + searches the
   * store directly). Same as Python's engine._embed / engine._store. */
  get embedder(): EmbedFn {
    return this._embed;
  }
  get store(): Store {
    return this._store;
  }

  /** Serialize the read-modify-write sequences (search→touch dedup, update's
   * get→upsert) so interleaved async callers can't lose an increment. */
  private _withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._queue.then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async remember(
    text: string,
    opts: {
      type?: string;
      project?: string;
      agent?: string;
      createdAt?: number;
      sourceId?: string;
      sourceOffset?: number;
    } = {},
  ): Promise<RememberResult> {
    const {
      type = 'fact',
      project = GLOBAL_PROJECT,
      agent = 'unknown',
      createdAt,
      sourceId = '',
      sourceOffset = -1.0,
    } = opts;

    text = text.trim();
    if (!text) throw new Error('memory text is empty');
    if (!VALID_TYPES.includes(type as MemoryType)) {
      throw new Error(`type must be one of ${VALID_TYPES.join(', ')}`);
    }

    const vector = await this._embed(text);
    const now = Date.now() / 1000;

    return this._withLock(async () => {
      // Near-duplicate in the same scope becomes a reinforcement, not a new row.
      const existing = await this._store.search(vector, [project], 1);
      if (existing.length) {
        const [record, similarity] = existing[0];
        if (similarity >= DEDUP_THRESHOLD) {
          const strength = (record.strength ?? 1.0) + 1.0;
          await this._store.touch(record.id, { accessedAt: now, strength });
          return { status: 'reinforced' as const, id: record.id, strength };
        }
      }

      const record: MemoryRecord = {
        id: crypto.randomUUID().replace(/-/g, ''),
        text,
        type,
        project,
        agent,
        created_at: createdAt ?? now,
        accessed_at: now,
        strength: 1.0,
        source_id: sourceId || '',
        source_offset: sourceOffset,
      };
      await this._store.upsert(record, vector);
      return { status: 'created' as const, id: record.id };
    });
  }

  async recall(
    query: string,
    opts: { project?: string; limit?: number } = {},
  ): Promise<RecallHit[]> {
    const { project = GLOBAL_PROJECT, limit = 5 } = opts;
    const vector = await this._embed(query);
    const projects = project === GLOBAL_PROJECT ? [project] : [project, GLOBAL_PROJECT];

    return this._withLock(async () => {
      // Hybrid recall (vector + BM25 via RRF) when the store supports it;
      // this lifts exact-keyword matches (identifiers, numbers, file names)
      // that pure vector similarity buries. Falls back to vector-only
      // transparently if hybridSearch is unavailable.
      const candidates = this._store.hybridSearch
        ? await this._store.hybridSearch(query, vector, projects, Math.max(limit * 3, 12))
        : await this._store.search(vector, projects, Math.max(limit * 3, 12));

      const now = Date.now() / 1000;
      const scored: { score: number; similarity: number; record: MemoryRecord }[] = [];
      for (const [record, similarity] of candidates) {
        const ageDays = Math.max(0.0, (now - (record.created_at ?? now)) / 86400.0);
        const recency = Math.exp((-ageDays * Math.LN2) / RECENCY_HALF_LIFE_DAYS);
        const strengthBoost = 1.0 + 0.1 * Math.log1p(record.strength ?? 1.0);
        // 推翻链：被取代的旧版大幅降权（保留可查，但不再是当前认知）
        const supersededPenalty = record.superseded_by ? 0.4 : 1.0;
        const score = similarity * (0.7 + 0.3 * recency) * strengthBoost * supersededPenalty;
        scored.push({ score, similarity, record });
      }

      scored.sort((a, b) => b.score - a.score);
      const results: RecallHit[] = [];
      for (const { score, similarity, record } of scored.slice(0, limit)) {
        await this._store.touch(record.id, { accessedAt: now });
        results.push({
          id: record.id,
          text: record.text,
          type: record.type,
          project: record.project,
          agent: record.agent,
          score: Math.round(score * 10000) / 10000,
          similarity: Math.round(similarity * 10000) / 10000,
        });
      }
      return results;
    });
  }

  /** 推翻链：把 oldId 的记忆标记为被 newId 取代（旧版保留不删，编译/召回降权）。 */
  async markSuperseded(oldId: string, newId: string): Promise<boolean> {
    return this._withLock(async () => {
      const got = await this._store.get(oldId);
      if (!got) return false;
      const [record, vector] = got;
      record.superseded_by = newId;
      await this._store.upsert(record, vector);
      return true;
    });
  }

  /**
   * Find memories semantically similar to a given memory, by its own vector.
   *
   * Unlike recall(), this skips the query-embedding step (uses the memory's
   * stored vector directly) and applies NO recency/strength boost — the detail
   * panel wants pure semantic neighbors, not the same recency-weighted ranking
   * recall uses. Excludes the query memory itself.
   */
  async similar(
    memoryId: string,
    opts: { limit?: number } = {},
  ): Promise<RecallHit[]> {
    const { limit = 4 } = opts;
    return this._withLock(async () => {
      const got = await this._store.get(memoryId);
      if (!got) return [];
      const [record, vector] = got;
      // Search across the memory's project + global so neighbors in either
      // scope surface (matches recall's scoping convention).
      const projects = record.project === GLOBAL_PROJECT
        ? [GLOBAL_PROJECT]
        : [record.project, GLOBAL_PROJECT];
      const candidates = await this._store.search(vector, projects, limit + 1);
      const out: RecallHit[] = [];
      for (const [r, similarity] of candidates) {
        if (r.id === memoryId) continue; // exclude self
        out.push({
          id: r.id,
          text: r.text,
          type: r.type,
          project: r.project,
          agent: r.agent,
          // No recency/strength scoring here — similarity IS the score, so the
          // detail panel shows true semantic distance. Round for stable display.
          score: Math.round(similarity * 10000) / 10000,
          similarity: Math.round(similarity * 10000) / 10000,
        });
        if (out.length >= limit) break;
      }
      return out;
    });
  }

  async update(
    memoryId: string,
    fields: { text?: string; type?: string; project?: string } = {},
  ): Promise<{ status: 'updated' | 'not_found'; id: string }> {
    return this._withLock(async () => {
      const got = await this._store.get(memoryId);
      if (!got) return { status: 'not_found' as const, id: memoryId };
      let [record, vector] = got;
      if (fields.text !== undefined) {
        const text = fields.text.trim();
        if (!text) throw new Error('memory text is empty');
        record = { ...record, text };
        vector = await this._embed(text);
      }
      if (fields.type !== undefined) {
        if (!VALID_TYPES.includes(fields.type as MemoryType)) {
          throw new Error(`type must be one of ${VALID_TYPES.join(', ')}`);
        }
        record = { ...record, type: fields.type };
      }
      if (fields.project !== undefined) {
        record = { ...record, project: fields.project };
      }
      await this._store.upsert(record, vector);
      return { status: 'updated' as const, id: memoryId };
    });
  }

  async forget(memoryId: string): Promise<boolean> {
    return this._withLock(() => this._store.delete(memoryId));
  }
}
