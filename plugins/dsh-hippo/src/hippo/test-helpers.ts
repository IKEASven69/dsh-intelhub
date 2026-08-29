/**
 * Shared test fixtures: a deterministic fake embedder and an in-memory Store.
 * Not shipped — only imported by *.test.ts in this directory.
 */
import type { MemoryRecord, SearchHit, Store } from './memory.js';

export const FAKE_DIM = 32;

/** Deterministic bag-of-words embedding: token hashes into FAKE_DIM dims,
 * L2-normalized. Identical texts → cosine 1.0; disjoint tokens → ~0. */
export function fakeEmbed(text: string): Promise<Float32Array> {
  const v = new Float32Array(FAKE_DIM);
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!token) continue;
    let h = 0;
    for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
    v[h % FAKE_DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return Promise.resolve(v);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return dot; // both sides are pre-normalized
}

/** In-memory Store implementation for engine-level tests. */
export class FakeStore implements Store {
  rows = new Map<string, { record: MemoryRecord; vector: Float32Array }>();
  touches: { id: string; accessedAt: number; strength?: number }[] = [];

  upsert(record: MemoryRecord, vector: Float32Array): Promise<void> {
    this.rows.set(record.id, { record: { ...record }, vector });
    return Promise.resolve();
  }

  search(vector: Float32Array, projects: string[], limit: number): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    for (const { record, vector: v } of this.rows.values()) {
      if (!projects.includes(record.project)) continue;
      hits.push([{ ...record }, cosine(vector, v)]);
    }
    hits.sort((a, b) => b[1] - a[1]);
    return Promise.resolve(hits.slice(0, limit));
  }

  get(memoryId: string): Promise<[MemoryRecord, Float32Array] | null> {
    const row = this.rows.get(memoryId);
    return Promise.resolve(row ? [{ ...row.record }, row.vector] : null);
  }

  delete(memoryId: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(memoryId));
  }

  touch(memoryId: string, opts: { accessedAt: number; strength?: number }): Promise<void> {
    this.touches.push({ id: memoryId, accessedAt: opts.accessedAt, strength: opts.strength });
    const row = this.rows.get(memoryId);
    if (row) {
      row.record.accessed_at = opts.accessedAt;
      if (opts.strength !== undefined) row.record.strength = opts.strength;
    }
    return Promise.resolve();
  }
}
