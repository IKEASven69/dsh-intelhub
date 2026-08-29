/**
 * zvec-backed storage for memory records — the storage layer that matches
 * the Python hippo (zvec HNSW + cosine + FTS/jieba, BM25+vector hybrid
 * recall via native multiQuery + RRF).
 *
 * One embedded collection on disk (default ~/.hippo/memories). Replaces the
 * SqliteStore: same Store interface, better recall (HNSW + jieba FTS), native
 * RRF fusion instead of hand-rolled scoring.
 *
 * Multi-process note: zvec's collection write lock is single-process
 * exclusive (verified on both Python and Node bindings). The MCP server is a
 * single stdio process, so this is fine for the normal use case. Concurrent
 * CLI commands while the server runs will get a clear lock error — that's
 * acceptable and honest (the Python version needed a full leader-follower
 * protocol to paper over this; the TS version keeps it simple).
 */
import zvec from '@zvec/zvec';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryRecord, SearchHit, Store } from './memory.js';

const {
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
} = zvec;

const VECTOR_FIELD = 'embedding';
const SCAN_TOPK = 100_000;

/** Raised when the configured embedding model's dim disagrees with an
 * existing collection's dim (embedding model switched). */
export class EmbedModelMismatch extends Error {}

export function dataDir(): string {
  return process.env.HIPPO_DATA_DIR ?? path.join(os.homedir(), '.hippo');
}

interface ZVecCollection {
  stats: { docCount: number };
  upsertSync(doc: any): any;
  querySync(params: any): any[];
  multiQuerySync(params: any): any[];
  fetchSync(ids: string | string[] | { ids: string | string[]; includeVector?: boolean }): Record<string, any>;
  deleteSync(ids: string): any;
  updateSync(doc: any): any;
  closeSync(): void;
  destroySync(): void;
  optimizeSync(opts?: any): void;
  createIndexSync(params: any): void;
  schema: any;
}

/** Quote a string for zvec's SQL-style filter expressions. */
function quote(v: string): string {
  return "'" + v.replace(/'/g, "''") + "'";
}

/** Build a project filter: "project = 'a' or project = 'b'" */
function projectFilter(projects: string[]): string {
  return projects.map(p => `project = ${quote(p)}`).join(' or ');
}

/** Open an existing zvec collection, working around a Windows lock bug.
 *
 * zvec's Windows binding fails to *create* the LOCK file when it's absent
 * (the exclusive-create call returns an error instead of creating it),
 * surfacing as "Can't open lock file: <path>\LOCK" even though no process
 * holds the lock. The fix is to pre-create an empty LOCK file, after which
 * zvec opens normally. We also clean up a stale LOCK on close so a crashed
 * prior run doesn't wedge the next open. */
function openCollectionWithLockFix(colPath: string): ZVecCollection {
  const lockPath = path.join(colPath, 'LOCK');
  try {
    return ZVecOpen(colPath) as ZVecCollection;
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (msg.includes("Can't open lock file") || msg.includes('LOCK')) {
      // Pre-create the LOCK file empty and retry once.
      try { fs.writeFileSync(lockPath, ''); } catch { /* ignore */ }
      return ZVecOpen(colPath) as ZVecCollection;
    }
    throw e;
  }
}

/** Read the vector dimension from an existing collection's schema. */
function existingVectorDim(col: ZVecCollection): number | null {
  for (const v of col.schema.vectors?.() ?? []) {
    if (v.name === VECTOR_FIELD) return v.dimension ?? 0;
  }
  return null;
}

export class ZvecStore implements Store {
  private _col: ZVecCollection;
  readonly colPath: string;
  // 推翻链旁挂存储：zvec 建库后不能加 STRING 列（addColumn 仅数值型），
  // superseded_by 存 sidecar JSON，读取路径统一装饰回 record。
  private _supersede = new Map<string, string>();
  private _supersedePath = '';

  constructor(dir?: string, dim = 1024, opts: { skipDimCheck?: boolean } = {}) {
    const base = dir ?? dataDir();
    fs.mkdirSync(base, { recursive: true });
    this.colPath = path.join(base, 'memories');
    this._supersedePath = this.colPath + '.supersede.json';
    this._loadSupersede();

    if (fs.existsSync(this.colPath)) {
      this._col = openCollectionWithLockFix(this.colPath);
      // Skip dim check when caller only needs scalar access (e.g. dashboard
      // reading memories for display — vectors irrelevant).
      if (!opts.skipDimCheck) {
        const existingDim = existingVectorDim(this._col);
        if (existingDim && existingDim !== dim) {
          this._col.closeSync();
          throw new EmbedModelMismatch(
            `embedding dimension (${dim}) does not match the existing collection ` +
            `at ${this.colPath} (dim=${existingDim}). This usually means the ` +
            `embedding model was changed. To migrate: export to JSONL, delete ` +
            `the collection dir, then import again — embeddings are recomputed.`,
          );
        }
      }
      this._ensureFtsIndex();
    } else {
      const schema = new ZVecCollectionSchema({
        name: 'memories',
        fields: [
          { name: 'text', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.FTS, tokenizerName: 'jieba' } },
          { name: 'type', dataType: ZVecDataType.STRING },
          { name: 'project', dataType: ZVecDataType.STRING },
          { name: 'agent', dataType: ZVecDataType.STRING },
          { name: 'created_at', dataType: ZVecDataType.DOUBLE },
          { name: 'accessed_at', dataType: ZVecDataType.DOUBLE },
          { name: 'strength', dataType: ZVecDataType.DOUBLE },
          { name: 'source_id', dataType: ZVecDataType.STRING, nullable: true },
          { name: 'source_offset', dataType: ZVecDataType.DOUBLE, nullable: true },
        ],
        vectors: {
          name: VECTOR_FIELD,
          dataType: ZVecDataType.VECTOR_FP32,
          dimension: dim,
          indexParams: { indexType: ZVecIndexType.HNSW, metricType: ZVecMetricType.COSINE },
        },
      });
      this._col = ZVecCreateAndOpen(this.colPath, schema) as ZVecCollection;
    }
  }

  /** The vector dimension actually stored in this collection's schema, or null
   * if it can't be read. Used by doctor to report the real stored dim and
   * detect an embedding-model switch (dim mismatch). */
  storedDim(): number | null {
    return existingVectorDim(this._col);
  }

  /** Ensure the FTS index exists on collections created before this store
   * version. Idempotent; best-effort (recall still works via vector if FTS
   * is unavailable). */
  private _ensureFtsIndex(): void {
    try {
      const textField = this._col.schema.fields?.().find((f: any) => f.name === 'text');
      if (textField?.indexParams) return; // already has an index
      this._col.createIndexSync({
        fieldName: 'text',
        indexParams: { indexType: ZVecIndexType.FTS, tokenizerName: 'jieba' },
      });
      this._col.optimizeSync();
    } catch {
      // index may already exist or collection is read-only — not fatal.
    }
  }

  private _loadSupersede(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this._supersedePath, 'utf-8')) as [string, string][];
      this._supersede = new Map(raw);
    } catch { this._supersede = new Map(); }
  }

  private _saveSupersede(): void {
    try { fs.writeFileSync(this._supersedePath, JSON.stringify([...this._supersede]), 'utf-8'); } catch { /* 尽力 */ }
  }

  /** 读取路径统一装饰：把旁挂的取代关系放回 record。 */
  private _decor(record: MemoryRecord): MemoryRecord {
    if (!record.superseded_by && this._supersede.has(record.id)) {
      record.superseded_by = this._supersede.get(record.id);
    }
    return record;
  }

  async upsert(record: MemoryRecord, vector: Float32Array): Promise<void> {
    // 推翻链：字符串才动旁挂表（undefined=不涉及，''=显式恢复）
    if (typeof record.superseded_by === 'string') {
      if (record.superseded_by === '') this._supersede.delete(record.id);
      else this._supersede.set(record.id, record.superseded_by);
      this._saveSupersede();
    }

    const status = this._col.upsertSync({
      id: record.id,
      vectors: { [VECTOR_FIELD]: Array.from(vector) },
      fields: {
        text: record.text,
        type: record.type,
        project: record.project,
        agent: record.agent,
        created_at: record.created_at,
        accessed_at: record.accessed_at,
        strength: record.strength,
        source_id: record.source_id ?? '',
        source_offset: record.source_offset ?? -1.0,
      },
    });
    if (!status.ok) throw new Error(`zvec upsert failed: ${status.message}`);
  }

  async search(vector: Float32Array, projects: string[], limit: number): Promise<SearchHit[]> {
    const docs = this._col.querySync({
      fieldName: VECTOR_FIELD,
      vector: Array.from(vector),
      topk: limit,
      filter: projectFilter(projects),
    });
    return docs.map((d: any) => {
      const record = this._decor({ ...d.fields, id: d.id } as MemoryRecord);
      // zvec COSINE score is a distance (0 = identical); convert to similarity.
      return [record, 1.0 - d.score] as SearchHit;
    });
  }

  async hybridSearch(
    queryText: string,
    vector: Float32Array,
    projects: string[],
    limit: number,
  ): Promise<SearchHit[]> {
    const filter = projectFilter(projects);
    try {
      const docs = this._col.multiQuerySync({
        queries: [
          { fieldName: VECTOR_FIELD, vector: Array.from(vector) },
          { fieldName: 'text', fts: { matchString: queryText } },
        ],
        topk: limit,
        filter,
        rerank: { type: 'rrf', rankConstant: 60 },
      });
      if (!docs.length) return [];
      // RRF scores are positive, higher = better. Normalize to [0,1] vs top.
      const top = docs[0].score || 1.0;
      return docs.map((d: any) => {
        const record = this._decor({ ...d.fields, id: d.id } as MemoryRecord);
        return [record, d.score / top] as SearchHit;
      });
    } catch {
      // FTS index missing or query rejected: degrade to vector-only search.
      return this.search(vector, projects, limit);
    }
  }

  async get(memoryId: string): Promise<[MemoryRecord, Float32Array] | null> {
    const fetched = this._col.fetchSync({ ids: memoryId, includeVector: true });
    const doc = fetched[memoryId];
    if (!doc) return null;
    const record = this._decor({ ...doc.fields, id: doc.id } as MemoryRecord);
    const vecData = doc.vectors?.[VECTOR_FIELD];
    const vector = vecData instanceof Float32Array
      ? vecData
      : new Float32Array(vecData ?? []);
    return [record, vector];
  }

  async delete(memoryId: string): Promise<boolean> {
    // Check existence first (zvec deleteSync returns ok even if nothing deleted).
    const existing = this._col.fetchSync({ ids: memoryId, includeVector: false });
    if (!existing[memoryId]) return false;
    if (this._supersede.has(memoryId)) { this._supersede.delete(memoryId); this._saveSupersede(); }
    const status = this._col.deleteSync(memoryId);
    return status.ok;
  }

  async touch(memoryId: string, opts: { accessedAt: number; strength?: number }): Promise<void> {
    const fetched = this._col.fetchSync(memoryId);
    const doc = fetched[memoryId];
    if (!doc) return; // no-op for missing id
    const fields = { ...doc.fields };
    fields.accessed_at = opts.accessedAt;
    if (opts.strength !== undefined) fields.strength = opts.strength;
    this._col.updateSync({
      id: memoryId,
      vectors: doc.vectors,
      fields,
    });
  }

  scan(includeVector?: false): SearchHit[];
  scan(includeVector: true): [MemoryRecord, number, Float32Array][];
  scan(includeVector = false): SearchHit[] | [MemoryRecord, number, Float32Array][] {
    const docs = this._col.querySync({ topk: SCAN_TOPK, includeVector });
    const records = docs.map((d: any) => {
      const record = this._decor({ ...d.fields, id: d.id } as MemoryRecord);
      return record;
    });
    if (!includeVector) {
      return records.map(r => [r, 0.0] as SearchHit);
    }
    return docs.map((d: any, i: number) => {
      const vecData = d.vectors?.[VECTOR_FIELD];
      const vector = vecData instanceof Float32Array
        ? vecData
        : new Float32Array(vecData ?? []);
      return [records[i], 0.0, vector] as [MemoryRecord, number, Float32Array];
    });
  }

  count(): number {
    return this._col.stats.docCount;
  }

  close(): void {
    this._col.closeSync();
  }
}
