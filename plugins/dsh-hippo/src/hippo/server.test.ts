import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHippoMcpServer } from './server.js';
import { MemoryEngine } from './memory.js';
import { fakeEmbed, FakeStore } from './test-helpers.js';

async function connectedClient(): Promise<{ client: Client; close(): Promise<void> }> {
  const engine = new MemoryEngine(new FakeStore(), fakeEmbed);
  const server = createHippoMcpServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function payload(result: unknown): unknown {
  const r = result as { content: { type: string; text: string }[] };
  return JSON.parse(r.content[0].text);
}

test('server lists the fourteen hippo tools', async () => {
  const { client, close } = await connectedClient();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map(t => t.name).sort(),
      ['compile', 'distill', 'forget', 'memory_review', 'memory_status', 'recall', 'remember', 'session_delete', 'sleep', 'stats', 'supersede', 'task_list', 'task_update', 'update'],
    );
  } finally {
    await close();
  }
});

test('remember → recall → update → forget roundtrip over MCP', async () => {
  const { client, close } = await connectedClient();
  try {
    const remembered = payload(await client.callTool({
      name: 'remember',
      arguments: { text: '端口是 3456', type: 'fact', project: 'proj-a', agent: 'mcp-test' },
    })) as { status: string; id: string };
    assert.equal(remembered.status, 'created');

    // duplicate reinforces
    const again = payload(await client.callTool({
      name: 'remember',
      arguments: { text: '端口是 3456', type: 'fact', project: 'proj-a' },
    })) as { status: string; strength: number };
    assert.equal(again.status, 'reinforced');
    assert.equal(again.strength, 2);

    const hits = payload(await client.callTool({
      name: 'recall', arguments: { query: '端口', project: 'proj-a' },
    })) as { id: string; text: string }[];
    assert.equal(hits[0].id, remembered.id);

    const updated = payload(await client.callTool({
      name: 'update',
      arguments: { memory_id: remembered.id, text: '端口是 4567' },
    })) as { status: string };
    assert.equal(updated.status, 'updated');

    const forgotten = payload(await client.callTool({
      name: 'forget', arguments: { memory_id: remembered.id },
    })) as { deleted: boolean };
    assert.equal(forgotten.deleted, true);

    const gone = payload(await client.callTool({
      name: 'forget', arguments: { memory_id: remembered.id },
    })) as { deleted: boolean };
    assert.equal(gone.deleted, false);
  } finally {
    await close();
  }
});

test('invalid input becomes a structured error result, not a crash', async () => {
  const { client, close } = await connectedClient();
  try {
    const bad = payload(await client.callTool({
      name: 'remember', arguments: { text: '   ' }, // schema-valid, engine rejects
    })) as { status: string; error: string };
    assert.equal(bad.status, 'error');
    assert.match(bad.error, /memory text is empty/);
  } finally {
    await close();
  }
});

test('distill tool returns scored candidates without writing', async () => {
  const { client, close } = await connectedClient();
  try {
    const transcript = JSON.stringify({
      type: 'user',
      cwd: 'D:/proj/demo',
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: '我们决定用 SQLite。端口是 3456。' },
    });
    const candidates = payload(await client.callTool({
      name: 'distill', arguments: { transcript },
    })) as { text: string; type: string; duplicate: string; project: string }[];
    assert.ok(candidates.length >= 2);
    assert.ok(candidates.every(c => c.duplicate === 'new')); // empty store
    assert.ok(candidates.every(c => c.project === 'demo'));
    assert.ok(candidates.some(c => c.type === 'decision'));
    assert.ok(candidates.some(c => c.type === 'fact'));
  } finally {
    await close();
  }
});
