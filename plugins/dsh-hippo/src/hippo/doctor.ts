/**
 * Diagnostic and recovery tools for the hippo store.
 *
 * v0.2+ stores memories in a zvec collection (HNSW + jieba FTS); earlier
 * versions used SQLite. This module is backend-aware: `diagnose` probes
 * whichever store is present, and `salvage`/`rebuild` work on both. The zvec
 * path additionally papers over zvec's Windows LOCK-file bug (see
 * ZvecStore.openCollectionWithLockFix) so a crashed prior run doesn't wedge
 * recovery.
 *
 * SQLite-specific checks (run only when the legacy db is present):
 *
 *   - integrity_check      raw SQLite page corruption
 *   - dimension match      embedding model switched → vec0 dim mismatch
 *   - orphan vectors       vec_memories rows whose memory_id isn't in memories
 *   - orphan memories      memories rows missing a vector in vec_memories
 *   - FTS5 row count drift messages_fts out of sync with messages
 *
 * `salvage` exports every recoverable memory (text + metadata) to JSONL by
 * reading the store directly — vectors are never exported, so a salvage
 * crosses an embedding-model switch cleanly (this is how a dim mismatch gets
 * recovered). `rebuild` salvages → backs up → drops the store → re-imports
 * through the engine, re-embedding everything with the current model.
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appPath, APP_DIR } from '../core/paths.js';

const DB_PATH = appPath('memories.db');

export interface Diagnostics {
  dataDir: string;
  dbPath: string;
  dbExists: boolean;
  integrity: 'ok' | string;
  memoryCount: number;
  vectorCount: number;
  orphanVectors: number; // vec_memories rows whose memory_id isn't in memories
  orphanMemories: number; // memories rows missing a vector
  ftsDrift: number; // |memories| - |messages_fts| (negative = FTS has stale rows)
  vectorDim: number | null; // null if vec table absent
  providerDim: number | null; // current embedder's dim
  dimMismatch: boolean;
}

/** Collect diagnostic facts without modifying anything. Always safe to run.
 *
 * If an already-open store is passed (e.g. the HTTP server's engine.store),
 * use it instead of opening a new one — avoids zvec's single-writer lock. */
export async function diagnose(storeIn?: { scan(): [any, number][]; count(): number; storedDim?(): number | null }): Promise<Diagnostics> {
  // zvec collection (v0.2+ storage) — check the collection dir, not memories.db
  const colPath = path.join(APP_DIR, 'memories');
  const colExists = fs.existsSync(colPath);
  if (colExists) {
    // Use the passed-in store if available (avoids lock contention with an
    // already-open engine); otherwise open read-only.
    let store = storeIn;
    let openedHere = false;
    try {
      if (!store) {
        const { ZvecStore } = await import('./zvec-store.js');
        store = new ZvecStore(APP_DIR, 1, { skipDimCheck: true });
        openedHere = true;
      }
      const count = store.count();
      // Read the actually-stored vector dim from the collection schema, and
      // the current embedder's dim, so doctor can flag a model switch.
      let vectorDim: number | null = null;
      let providerDim: number | null = null;
      let dimMismatch = false;
      try {
        vectorDim = store.storedDim?.() ?? null;
        const { getProvider } = await import('../core/search/index.js');
        providerDim = getProvider().dim;
        if (vectorDim !== null && providerDim !== null) {
          dimMismatch = vectorDim !== providerDim;
        }
      } catch { /* dim probing best-effort; counts are still useful */ }
      return {
        dataDir: APP_DIR,
        dbPath: colPath,
        dbExists: true,
        integrity: 'ok',
        memoryCount: count,
        vectorCount: count,
        orphanVectors: 0,    // zvec has no separate vec table
        orphanMemories: 0,
        ftsDrift: 0,
        vectorDim,
        providerDim,
        dimMismatch,
      };
    } catch (e) {
      return {
        dataDir: APP_DIR,
        dbPath: colPath,
        dbExists: true,
        integrity: `zvec open failed: ${(e as Error).message}`,
        memoryCount: 0,
        vectorCount: 0,
        orphanVectors: 0,
        orphanMemories: 0,
        ftsDrift: 0,
        vectorDim: null,
        providerDim: null,
        dimMismatch: false,
      };
    } finally {
      if (openedHere && store && typeof (store as any).close === 'function') {
        try { (store as any).close(); } catch { /* ignore */ }
      }
    }
  }

  // Legacy SQLite db (pre-v0.2) — fall through to the SQLite path below.
  const dbExists = fs.existsSync(DB_PATH);
  const base: Diagnostics = {
    dataDir: APP_DIR,
    dbPath: DB_PATH,
    dbExists,
    integrity: dbExists ? 'unknown' : 'no-db',
    memoryCount: 0,
    vectorCount: 0,
    orphanVectors: 0,
    orphanMemories: 0,
    ftsDrift: 0,
    vectorDim: null,
    providerDim: null,
    dimMismatch: false,
  };
  if (!dbExists) return base;

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    // vec0 virtual tables need the extension loaded even for read-only access.
    try {
      // 非字面量说明符:尽力探测旧存储的 vec 扩展,包不存在属预期
      // (TS 也因此不做严格类型解析)。
      const vecMod = 'sqlite-vec';
      const { load: loadVec } = await import(vecMod);
      loadVec(db);
    } catch {
      // extension missing — vec_* queries will fail below, but plain SQLite checks still run
    }

    const ic = db.pragma('integrity_check', { simple: true });
    base.integrity = Array.isArray(ic) ? ic[0] as string : String(ic);
    if (base.integrity !== 'ok') return base; // stop probing a corrupt db

    base.memoryCount = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;

    const hasVec = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_memories'").get();
    if (hasVec) {
      base.vectorCount = (db.prepare('SELECT COUNT(*) c FROM vec_memories').get() as { c: number }).c;
      base.orphanVectors = (db.prepare(
        `SELECT COUNT(*) c FROM vec_memories v LEFT JOIN memories m ON m.id = v.memory_id WHERE m.id IS NULL`,
      ).get() as { c: number }).c;
      base.orphanMemories = (db.prepare(
        `SELECT COUNT(*) c FROM memories m LEFT JOIN vec_memories v ON v.memory_id = m.id WHERE v.memory_id IS NULL`,
      ).get() as { c: number }).c;
      // vec0 hides the dim in metadata; infer from a probe row if any vector exists
      if (base.vectorCount > 0) {
        const row = db.prepare('SELECT embedding FROM vec_memories LIMIT 1').get() as { embedding: Buffer } | undefined;
        if (row?.embedding) base.vectorDim = row.embedding.byteLength / 4; // float32
      }
    }

    const hasFts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
    if (hasFts) {
      const ftsCount = (db.prepare('SELECT COUNT(*) c FROM memories_fts').get() as { c: number }).c;
      base.ftsDrift = base.memoryCount - ftsCount;
    }

    // Current provider dim — getProvider() itself is lazy (doesn't load the
    // ONNX model until embed() is called), so reading .dim is cheap.
    try {
      const { getProvider } = await import('../core/search/index.js');
      base.providerDim = getProvider().dim;
      if (base.vectorDim !== null && base.providerDim !== null) {
        base.dimMismatch = base.vectorDim !== base.providerDim;
      }
    } catch {
      // provider module unavailable — leave providerDim null
    }

    return base;
  } finally {
    db.close();
  }
}

/** Read every recoverable memory row as JSONL-serializable dicts.
 *
 * Backend-agnostic: reads the zvec collection if present (v0.2+ default),
 * otherwise falls back to the legacy SQLite db. Vectors are never exported —
 * they're recomputed on import, so a salvage crosses embedding-model switches
 * cleanly (this is exactly how a dim mismatch gets recovered). */
export async function salvage(): Promise<Record<string, unknown>[]> {
  const colPath = path.join(APP_DIR, 'memories');
  if (fs.existsSync(colPath)) {
    return salvageZvec();
  }
  if (!fs.existsSync(DB_PATH)) throw new Error(`no store at ${colPath} or ${DB_PATH}`);
  return salvageSqlite();
}

/** Salvage from the zvec collection via a read-only store open. */
async function salvageZvec(): Promise<Record<string, unknown>[]> {
  // Lazy import so the SQLite-only path doesn't pull zvec's native binding.
  const { ZvecStore } = await import('./zvec-store.js');
  const store = new ZvecStore(APP_DIR, 1, { skipDimCheck: true });
  try {
    return store.scan().map(([r]) => ({
      text: r.text,
      type: r.type,
      project: r.project,
      agent: r.agent,
      created_at: r.created_at,
      accessed_at: r.accessed_at,
      strength: r.strength,
      // Preserve provenance so a rebuild keeps L0 source links intact —
      // dropping these would orphan the L0 blobs in ~/.hippo/sources/.
      source_id: r.source_id ?? '',
      source_offset: r.source_offset ?? -1,
    }));
  } finally {
    store.close();
  }
}

/** Salvage from the legacy SQLite db. */
function salvageSqlite(): Record<string, unknown>[] {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT id, text, type, project, agent, created_at, accessed_at, strength, source_id, source_offset
       FROM memories ORDER BY created_at`,
    ).all() as Record<string, unknown>[];
    return rows;
  } finally {
    db.close();
  }
}

/** Write records to a JSONL file. Returns count written. */
export function writeJsonl(records: Record<string, unknown>[], outPath: string): number {
  const lines = records.map(r => JSON.stringify(r));
  fs.writeFileSync(outPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
  return lines.length;
}

export interface RebuildResult {
  salvaged: number;
  backup: string;
  created: number;
  reinforced: number;
  skipped: number;
}

/**
 * salvage → backup → delete store → re-import via the engine (re-embeds everything).
 * The recovery path for corruption or a dimension switch.
 *
 * Drops whichever backend is present — the zvec collection dir (v0.2+) or the
 * legacy SQLite db — then re-imports through the engine so embeddings are
 * recomputed with the current model and dedup-reinforce applies.
 */
export async function rebuild(backupPath?: string): Promise<RebuildResult> {
  const records = await salvage();
  const tmp = await import('node:os').then(os => os.tmpdir());
  backupPath = backupPath ?? path.join(tmp, `hippo_salvage_${Date.now()}.jsonl`);
  writeJsonl(records, backupPath);

  // Drop whichever store backend is present, so rebuild starts clean.
  const colPath = path.join(APP_DIR, 'memories');
  if (fs.existsSync(colPath)) {
    // zvec collection (v0.2+). Remove the LOCK first so rmSync doesn't trip
    // on a held handle, then delete the whole dir.
    const lockPath = path.join(colPath, 'LOCK');
    if (fs.existsSync(lockPath)) { try { fs.rmSync(lockPath); } catch { /* may be held */ } }
    fs.rmSync(colPath, { recursive: true, force: true });
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = DB_PATH + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  // Re-import through the engine so embeddings are recomputed and dedup runs.
  const { openEngine } = await import('./engine.js');
  const { importJsonl } = await import('./transfer.js');
  const { engine, close } = openEngine();
  try {
    const text = fs.readFileSync(backupPath, 'utf-8');
    const counts = await importJsonl(engine, text);
    return {
      salvaged: records.length,
      backup: backupPath,
      created: counts.created,
      reinforced: counts.reinforced,
      skipped: counts.skipped,
    };
  } finally {
    close();
  }
}
