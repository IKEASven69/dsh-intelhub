/**
 * HTTP-proxying MemoryEngine.
 *
 * zvec's storage uses single-writer locks (both the HNSW index and the
 * LevelDB idmap), so two processes can't both open the same collection
 * read-write. That means `hippo ui` (the HTTP/Web server) and `hippo serve`
 * (the MCP stdio server) conflict if each opens its own engine.
 *
 * This proxy solves it for the common deployment: run ONE long-lived
 * `hippo ui` process that owns the store, and have `hippo serve` proxy all
 * engine calls to its HTTP API. The MCP server then holds no lock and any
 * number of MCP clients + the Web UI work concurrently.
 *
 * Only the engine methods the MCP tools use are proxied (remember / recall /
 * update / forget / similar). distill's candidate *extraction* is pure
 * (runs locally in the MCP process); only the final remember() calls that
 * persist candidates go through this proxy.
 */
import type { MemoryEngine, RecallHit, RememberResult } from './memory.js';

export class HttpProxyEngine implements Pick<MemoryEngine, 'remember' | 'recall' | 'update' | 'forget' | 'similar'> {
  constructor(private baseUrl: string) {}

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  }

  private async patch(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  }

  private async del(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  }

  async remember(
    text: string,
    opts: { type?: string; project?: string; agent?: string; createdAt?: number; sourceId?: string; sourceOffset?: number } = {},
  ): Promise<RememberResult> {
    return this.post('/api/memories', {
      text,
      type: opts.type,
      project: opts.project,
      agent: opts.agent,
    });
  }

  async recall(query: string, opts: { project?: string; limit?: number } = {}): Promise<RecallHit[]> {
    return (await this.post('/api/recall', { query, project: opts.project, limit: opts.limit })) as RecallHit[];
  }

  async update(memoryId: string, fields: { text?: string; type?: string; project?: string }): Promise<{ status: 'updated' | 'not_found'; id: string }> {
    const r = await this.patch(`/api/memories/${encodeURIComponent(memoryId)}`, fields);
    // The HTTP API returns {status: 'updated', id} on success; normalize the
    // literal type so this satisfies the MemoryEngine contract.
    return { status: r.status === 'updated' ? 'updated' : 'not_found', id: r.id };
  }

  async forget(memoryId: string): Promise<boolean> {
    const r = await this.del(`/api/memories/${encodeURIComponent(memoryId)}`);
    return !!r.deleted;
  }

  async similar(memoryId: string, opts: { limit?: number } = {}): Promise<RecallHit[]> {
    const limit = opts.limit ?? 4;
    const res = await fetch(`${this.baseUrl}/api/memories/${encodeURIComponent(memoryId)}/similar?limit=${limit}`);
    if (!res.ok) throw new Error(`similar -> ${res.status}`);
    return (await res.json()) as RecallHit[];
  }
}
