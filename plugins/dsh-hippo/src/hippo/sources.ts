/**
 * L0 source storage — raw transcript turns backing distilled memories.
 * TS port of hippo sources.py.
 *
 * When distill extracts L1 candidate memories from a transcript, the full
 * conversation that produced them is saved here as an L0 "source blob"
 * (JSON file under <dataDir>/sources/<source_id>.json). Each L1 memory
 * records the source_id and a source_offset (the turn index it was distilled
 * from), so a dashboard can replay the original conversation that led to a
 * memory — the way to audit/correct a wrong distillation.
 *
 * This is intentionally separate from SQLite: L0 blobs are large, rarely
 * accessed, and not semantic-search targets. They live as plain JSON files.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { dataDir as defaultDataDir } from './store.js';

// Cap turns per source so a single huge transcript can't balloon disk usage.
// Distillation signal is front-loaded; later turns rarely add new candidates.
export const MAX_SOURCE_TURNS = 500;

export interface SourceMeta {
  source_id: string;
  saved_at: number;
  project: string;
  agent: string;
  turn_count: number;
  original_turn_count: number;
  truncated: boolean;
}

export interface SourceBlob extends SourceMeta {
  turns: Record<string, unknown>[];
}

function sourcesDir(dir: string): string {
  const d = path.join(dir, 'sources');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Persist an L0 transcript blob. Returns the source_id. Turns beyond
 * MAX_SOURCE_TURNS are truncated and the blob is flagged. */
export function saveSource(
  turns: Record<string, unknown>[],
  opts: { project?: string; agent?: string; dataDir?: string } = {},
): string {
  const dir = opts.dataDir ?? defaultDataDir();
  const sourceId = crypto.randomUUID().replace(/-/g, '');
  const truncated = turns.length > MAX_SOURCE_TURNS;
  const kept = turns.slice(0, MAX_SOURCE_TURNS);
  const blob: SourceBlob = {
    source_id: sourceId,
    saved_at: Date.now() / 1000,
    project: opts.project ?? '',
    agent: opts.agent ?? '',
    turn_count: kept.length,
    original_turn_count: turns.length,
    truncated,
    turns: kept,
  };
  fs.writeFileSync(path.join(sourcesDir(dir), `${sourceId}.json`), JSON.stringify(blob), 'utf-8');
  return sourceId;
}

/** Read an L0 blob. Returns null if it doesn't exist. */
export function loadSource(sourceId: string, opts: { dataDir?: string } = {}): SourceBlob | null {
  if (!sourceId) return null;
  const dir = opts.dataDir ?? defaultDataDir();
  try {
    return JSON.parse(fs.readFileSync(path.join(sourcesDir(dir), `${sourceId}.json`), 'utf-8')) as SourceBlob;
  } catch {
    return null;
  }
}

/** List all L0 sources (metadata only, no turns) newest-first. */
export function listSources(opts: { dataDir?: string } = {}): SourceMeta[] {
  const dir = opts.dataDir ?? defaultDataDir();
  const d = sourcesDir(dir);
  const out: SourceMeta[] = [];
  for (const name of fs.readdirSync(d)) {
    if (!name.endsWith('.json')) continue;
    try {
      const blob = JSON.parse(fs.readFileSync(path.join(d, name), 'utf-8')) as SourceBlob;
      out.push({
        source_id: blob.source_id,
        saved_at: blob.saved_at,
        project: blob.project,
        agent: blob.agent,
        turn_count: blob.turn_count,
        original_turn_count: blob.original_turn_count,
        truncated: blob.truncated ?? false,
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => (b.saved_at ?? 0) - (a.saved_at ?? 0));
  return out;
}

// source_id → 会话真实时间（最后一轮 turn 的 ts，epoch 秒）。进程级缓存。
// 时间线用：批量导入的记忆 created_at 全是导入当天，真实发生时间要从 L0 turns 里恢复。
let sourceTimeCache: { dir: string; map: Map<string, number> } | null = null;

export function sourceTimes(opts: { dataDir?: string } = {}): Map<string, number> {
  const dir = opts.dataDir ?? defaultDataDir();
  if (sourceTimeCache && sourceTimeCache.dir === dir) return sourceTimeCache.map;
  const map = new Map<string, number>();
  const d = sourcesDir(dir);
  // 只取文本里所有 "ts":"..." 的最大值，避免整包 JSON.parse 大转录
  const tsRe = /"ts":"([^"]+)"/g;
  for (const name of fs.readdirSync(d)) {
    if (!name.endsWith('.json')) continue;
    const sid = name.replace(/\.json$/, '');
    try {
      const text = fs.readFileSync(path.join(d, name), 'utf-8');
      let max = 0;
      for (const m of text.matchAll(tsRe)) {
        const t = Date.parse(m[1]);
        if (Number.isFinite(t) && t > max) max = t;
      }
      if (max > 0) map.set(sid, Math.floor(max / 1000));
    } catch {
      continue;
    }
  }
  sourceTimeCache = { dir, map };
  return map;
}
