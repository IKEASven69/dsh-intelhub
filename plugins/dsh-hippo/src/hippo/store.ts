/**
 * SQLite storage for memory records — replaces hippo store.py (zvec).
 *
 * One database file at <dataDir>/memories.db (dataDir defaults to
 * HIPPO_DATA_DIR or ~/.hippo, same as the Python version). Three parts:
 *   - memories       plain row table (metadata)
 *   - memories_fts   FTS5 over text, enables BM25 hybrid recall
 *   - vec_memories   vec0 virtual table, cosine KNN over embeddings
 *
 * No leader/follower dance: SQLite WAL allows many readers + one writer,
 * and each CLI/MCP process opens its own connection safely.
 */
import Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryRecord, SearchHit, Store } from './memory.js';

/** Raised when the configured embedding model's dim disagrees with the dim
 * of the vectors already on disk (embedding model switched). The message
 * guides through the export -> re-embed -> import migration path. */
export class EmbedModelMismatch extends Error {}

export function dataDir(): string {
  return process.env.HIPPO_DATA_DIR ?? path.join(os.homedir(), '.hippo');
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  type          TEXT NOT NULL,
  project       TEXT NOT NULL,
  agent         TEXT NOT NULL,
  created_at    REAL NOT NULL,
  accessed_at   REAL NOT NULL,
  strength      REAL NOT NULL DEFAULT 1.0,
  source_id     TEXT NOT NULL DEFAULT '',
  source_offset REAL NOT NULL DEFAULT -1.0
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
`;

interface MemoryRow {
  id: string;
  text: string;
  type: string;
  project: string;
  agent: string;
  created_at: number;
  accessed_at: number;
  strength: number;
  source_id: string;
  source_offset: number;
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  return { ...row };
}

function vecToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Words-only FTS5 query (mirrors the main index's fts5Query). */
function fts5Query(raw: string): string {
  const terms = raw
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => t.replace(/"/g, ''));
  return terms.length === 0 ? raw : terms.join(' OR ');
}

export class SqliteStore implements Store {
  private _db: Database.Database;
  readonly dbPath: string;

  constructor(dir?: string, dim = 1024) {
    const base = dir ?? dataDir();
    fs.mkdirSync(base, { recursive: true });
    this.dbPath = path.join(base, 'memories.db');
    this._db = new Database(this.dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('busy_timeout = 5000');
    this._db.exec(SCHEMA_SQL);
    loadSqliteVec(this._db);
    this._ensureVecTable(dim);
  }

  /** Create the vec0 table, or verify the existing one matches the current
   * embedding dim. A mismatch means the user switched models: fail fast with
   * an actionable message instead of corrupting queries (hippo store.py
   * EmbedModelMismatch behavior). */
  private _ensureVecTable(dim: number): void {
    const existing = this._db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_memories'")
      .get() as { name: string } | undefined;

    if (!existing) {
      this._db.exec(`
        CREATE VIRTUAL TABLE vec_memories USING vec0(
          memory_id TEXT,
          embedding float[${dim}] distance_metric=cosine
        );
      `);
      return;
    }

    // Probe with a zero vector of the current dim; vec0 rejects wrong dims.
    try {
      const probe = Buffer.from(new Float32Array(dim).buffer);
      const info = this._db
        .prepare('INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)')
        .run('__dim_probe__', probe);
      this._db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(info.lastInsertRowid);
    } catch {
      this._db.close(); // don't leak the handle on a failed open (Windows locks the file)
      throw new EmbedModelMismatch(
        `embedding dimension (${dim}) does not match the existing vec_memories table ` +
        `at ${this.dbPath}. This usually means the embedding model was changed. ` +
        `To migrate: export to JSONL, delete memories.db, then import again — ` +
        `embeddings are recomputed on import.`,
      );
    }
  }

  async upsert(record: MemoryRecord, vector: Float32Array): Promise<void> {
    const upsertRow = this._db.prepare(`
      INSERT INTO memories (id, text, type, project, agent, created_at, accessed_at, strength, source_id, source_offset)
      VALUES (@id, @text, @type, @project, @agent, @created_at, @accessed_at, @strength, @source_id, @source_offset)
      ON CONFLICT(id) DO UPDATE SET
        text=excluded.text, type=excluded.type, project=excluded.project,
        agent=excluded.agent, created_at=excluded.created_at,
        accessed_at=excluded.accessed_at, strength=excluded.strength,
        source_id=excluded.source_id, source_offset=excluded.source_offset
    `);
    const tx = this._db.transaction(() => {
      upsertRow.run(record);
      // vec0 rows are immutable: replace instead of update.
      this._db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(record.id);
      this._db
        .prepare('INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)')
        .run(record.id, vecToBuffer(vector));
    });
    tx();
  }

  async search(vector: Float32Array, projects: string[], limit: number): Promise<SearchHit[]> {
    // Over-fetch from the KNN index, then filter by project. A personal
    // memory store is small, so 5x oversampling keeps recall exact enough.
    const k = Math.max(limit * 5, 50);
    const neighbors = this._db
      .prepare(`
        SELECT memory_id, distance
        FROM vec_memories
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `)
      .all(vecToBuffer(vector), k) as { memory_id: string; distance: number }[];
    return this._hitsFromNeighbors(neighbors, projects, limit);
  }

  /** Hybrid recall: vector KNN + FTS5 BM25 over text, fused via RRF
   * (k=60). Returns hits whose similarity slot is the RRF score normalized
   * to [0,1] against the top hit, so the downstream recency/strength formula
   * in recall() stays sane. Degrades to vector-only when FTS matches
   * nothing. (Port of ZvecStore.hybrid_search.) */
  async hybridSearch(
    queryText: string,
    vector: Float32Array,
    projects: string[],
    limit: number,
  ): Promise<SearchHit[]> {
    const RRF_K = 60;
    const fetchLimit = Math.max(limit * 3, 50);

    const vecHits = await this.search(vector, projects, fetchLimit);

    let ftsRows: { id: string }[] = [];
    try {
      const placeholders = projects.map(() => '?').join(', ');
      ftsRows = this._db
        .prepare(`
          SELECT m.id AS id
          FROM memories_fts f
          JOIN memories m ON m.rowid = f.rowid
          WHERE memories_fts MATCH ? AND m.project IN (${placeholders})
          ORDER BY rank
          LIMIT ?
        `)
        .all(fts5Query(queryText), ...projects, fetchLimit) as { id: string }[];
    } catch {
      // FTS query rejected (e.g. only special chars): vector-only.
      return vecHits.slice(0, limit);
    }

    // RRF: score = sum over lanes of 1/(k + rank)
    const scores = new Map<string, number>();
    const byId = new Map<string, MemoryRecord>();
    vecHits.forEach(([record], i) => {
      scores.set(record.id, (scores.get(record.id) ?? 0) + 1 / (RRF_K + i + 1));
      byId.set(record.id, record);
    });
    ftsRows.forEach(({ id }, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    });

    // FTS-only hits need their full row loaded.
    const missing = [...scores.keys()].filter(id => !byId.has(id));
    for (const id of missing) {
      const row = this._db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
      if (row) byId.set(id, rowToRecord(row));
    }

    const fused = [...scores.entries()]
      .filter(([id]) => byId.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
    const top = fused.length ? fused[0][1] : 1.0;
    return fused.map(([id, score]) => [byId.get(id)!, top > 0 ? score / top : 0.0]);
  }

  private _hitsFromNeighbors(
    neighbors: { memory_id: string; distance: number }[],
    projects: string[],
    limit: number,
  ): SearchHit[] {
    if (!neighbors.length) return [];
    const distById = new Map(neighbors.map(n => [n.memory_id, n.distance]));
    const ids = [...distById.keys()];
    const placeholders = ids.map(() => '?').join(', ');
    const projPh = projects.map(() => '?').join(', ');
    const rows = this._db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) AND project IN (${projPh})`)
      .all(...ids, ...projects) as MemoryRow[];
    return rows
      .map(row => [rowToRecord(row), 1.0 - distById.get(row.id)!] as SearchHit)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
  }

  async get(memoryId: string): Promise<[MemoryRecord, Float32Array] | null> {
    const row = this._db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as MemoryRow | undefined;
    if (!row) return null;
    const vecRow = this._db
      .prepare('SELECT embedding FROM vec_memories WHERE memory_id = ?')
      .get(memoryId) as { embedding: Buffer } | undefined;
    const vector = vecRow
      ? new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4)
      : new Float32Array(0);
    return [rowToRecord(row), vector];
  }

  async delete(memoryId: string): Promise<boolean> {
    const tx = this._db.transaction(() => {
      const result = this._db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
      this._db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(memoryId);
      return result.changes > 0;
    });
    return tx();
  }

  async touch(memoryId: string, opts: { accessedAt: number; strength?: number }): Promise<void> {
    if (opts.strength !== undefined) {
      this._db
        .prepare('UPDATE memories SET accessed_at = ?, strength = ? WHERE id = ?')
        .run(opts.accessedAt, opts.strength, memoryId);
    } else {
      this._db
        .prepare('UPDATE memories SET accessed_at = ? WHERE id = ?')
        .run(opts.accessedAt, memoryId);
    }
  }

  /** Every record (similarity slot 0.0 — no query vector). With
   * includeVector, each record's vector is appended after the similarity. */
  scan(includeVector?: false): SearchHit[];
  scan(includeVector: true): [MemoryRecord, number, Float32Array][];
  scan(includeVector = false): SearchHit[] | [MemoryRecord, number, Float32Array][] {
    const rows = this._db.prepare('SELECT * FROM memories').all() as MemoryRow[];
    if (!includeVector) return rows.map(r => [rowToRecord(r), 0.0] as SearchHit);
    const vecStmt = this._db.prepare('SELECT embedding FROM vec_memories WHERE memory_id = ?');
    return rows.map(r => {
      const vecRow = vecStmt.get(r.id) as { embedding: Buffer } | undefined;
      const vector = vecRow
        ? new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4)
        : new Float32Array(0);
      return [rowToRecord(r), 0.0, vector] as [MemoryRecord, number, Float32Array];
    });
  }

  count(): number {
    return (this._db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
  }

  close(): void {
    this._db.close();
  }
}

// Re-export the zvec-backed store (preferred). The SqliteStore above is kept
// for reference and migration; new code should use ZvecStore.
export { ZvecStore, EmbedModelMismatch as ZvecEmbedModelMismatch } from './zvec-store.js';
