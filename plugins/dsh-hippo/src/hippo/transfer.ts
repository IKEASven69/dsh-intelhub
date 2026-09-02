/**
 * Import / export of memories. TS port of hippo transfer.py.
 *
 * Portable format is JSONL without vectors — embeddings are recomputed on
 * import, so files move cleanly between machines and embedding models.
 * Import goes through MemoryEngine.remember, so dedup-reinforce applies
 * and re-importing the same file is idempotent.
 */
import type { MemoryEngine, MemoryRecord } from './memory.js';

export const EXPORT_FIELDS = ['text', 'type', 'project', 'agent', 'created_at', 'accessed_at', 'strength', 'source_id', 'source_offset', 'superseded_by'] as const;
/** Fields shown by `list` — includes id so users can act on a row. */
export const LIST_FIELDS = ['id', 'text', 'type', 'project', 'agent', 'created_at', 'accessed_at', 'strength', 'source_id', 'source_offset', 'superseded_by'] as const;

type Scannable = { scan(): [MemoryRecord, number][] };

function pick(r: MemoryRecord, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = (r as unknown as Record<string, unknown>)[f];
  return out;
}

export function exportRecords(
  store: Scannable,
  opts: { project?: string; agent?: string } = {},
): Record<string, unknown>[] {
  let records = store.scan().map(([r]) => r);
  if (opts.project) records = records.filter(r => r.project === opts.project);
  if (opts.agent) records = records.filter(r => r.agent === opts.agent);
  records.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return records.map(r => pick(r, EXPORT_FIELDS));
}

/** Memories filtered by project/type/agent, newest first, with pagination.
 * includeSuperseded=false 时过滤已被取代的旧版（编译投影只出当前有效认知）。 */
export function listRecords(
  store: Scannable,
  opts: { project?: string; type?: string; agent?: string; limit?: number; offset?: number; includeSuperseded?: boolean } = {},
): Record<string, unknown>[] {
  const { limit = 50, offset = 0, includeSuperseded = true } = opts;
  let records = filteredRecords(store, opts);
  if (!includeSuperseded) records = records.filter(r => !r.superseded_by);
  const page = limit ? records.slice(offset, offset + limit) : records.slice(offset);
  return page.map(r => pick(r, LIST_FIELDS));
}

/** 筛选后总数（与 listRecords 同一套过滤器；分页页数用）。 */
export function countRecords(
  store: Scannable,
  opts: { project?: string; type?: string; agent?: string } = {},
): number {
  return filteredRecords(store, opts).length;
}

function filteredRecords(
  store: Scannable,
  opts: { project?: string; type?: string; agent?: string },
): MemoryRecord[] {
  let records = store.scan().map(([r]) => r);
  if (opts.project) records = records.filter(r => r.project === opts.project);
  if (opts.type) records = records.filter(r => r.type === opts.type);
  if (opts.agent) records = records.filter(r => r.agent === opts.agent);
  records.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  return records;
}

export function writeJsonl(records: Record<string, unknown>[]): string {
  return records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

/** Render memories as a Markdown section for CLAUDE.md / AGENTS.md. */
export function renderMarkdown(records: Record<string, unknown>[]): string {
  const byProject = new Map<string, Record<string, unknown>[]>();
  for (const r of records) {
    const project = String(r.project ?? 'global');
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project)!.push(r);
  }

  const zh: Record<string, string> = { fact: '事实', decision: '决策', lesson: '教训', preference: '偏好' };
  const lines = [
    '# Memories (exported by hippo)',
    '',
    `_generated ${new Date().toISOString().slice(0, 10)}; import back with_ \`hippo import\``,
    '',
  ];
  for (const project of [...byProject.keys()].sort()) {
    lines.push(`## ${project}`);
    for (const r of byProject.get(project)!) {
      const type = String(r.type ?? '');
      const tag = zh[type] ?? type;
      const strength = Number(r.strength ?? 1);
      const mark = strength > 1 ? ` (×${strength})` : '';
      lines.push(`- **[${tag}]** ${r.text}${mark}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface ImportCounts {
  created: number;
  reinforced: number;
  skipped: number;
  /** 被敏感信息闸门拒绝的条数（secret-guard）。 */
  rejected?: number;
}

export async function importJsonl(
  engine: MemoryEngine,
  text: string,
  opts: { agent?: string } = {},
): Promise<ImportCounts> {
  const counts: ImportCounts = { created: 0, reinforced: 0, skipped: 0 };
  const lines = text.split('\n');
  for (let lineNo = 1; lineNo <= lines.length; lineNo++) {
    const line = lines[lineNo - 1].trim();
    if (!line) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (typeof r.text !== 'string') throw new Error('missing text');
      const result = await engine.remember(r.text, {
        type: typeof r.type === 'string' ? r.type : 'fact',
        project: typeof r.project === 'string' ? r.project : 'global',
        agent: opts.agent ?? (typeof r.agent === 'string' ? r.agent : 'import'),
        createdAt: typeof r.created_at === 'number' ? r.created_at : undefined,
        // Preserve L0 provenance across export/import (and across a rebuild,
        // which round-trips through JSONL). Without these, source blobs in
        // ~/.hippo/sources/ get orphaned after a rebuild.
        sourceId: typeof r.source_id === 'string' ? r.source_id : undefined,
        sourceOffset: typeof r.source_offset === 'number' ? r.source_offset : undefined,
      });
      if (result.status === 'rejected') counts.rejected = (counts.rejected ?? 0) + 1;
      else counts[result.status] += 1;
    } catch (err) {
      counts.skipped += 1;
      console.error(`  line ${lineNo} skipped: ${(err as Error).message}`);
    }
  }
  return counts;
}
