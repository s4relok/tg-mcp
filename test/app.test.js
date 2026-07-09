import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createApp } from '../src/app.js';
import { createTelegramDigestService } from '../src/services/digestService.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function testConfig() {
  return {
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1',
    mcpPath: '/mcp',
    allowedHosts: ['127.0.0.1', 'localhost'],
    appAuthToken: ''
  };
}

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

test('health endpoint reports ok', async () => {
  const store = new MemoryTelegramStore();
  const app = createApp({
    config: testConfig(),
    store,
    digestService: createTelegramDigestService(store)
  });
  const server = await listen(app);

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.mcpPath, '/mcp');
  } finally {
    server.close();
  }
});

test('MCP endpoint exposes Telegram tools', async () => {
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'chat-1', title: 'Project Chat', enabled: true, tags: [] }]
  });
  const app = createApp({
    config: testConfig(),
    store,
    digestService: createTelegramDigestService(store)
  });
  const server = await listen(app);

  try {
    const { port } = server.address();
    const client = new Client({ name: 'tg-mcp-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    assert.ok(names.includes('get_daily_digest'));
    assert.ok(names.includes('search_telegram_messages'));

    const result = await client.callTool({ name: 'list_sources', arguments: {} });
    assert.equal(result.structuredContent.sources[0].sourceId, 'chat-1');

    await transport.close();
  } finally {
    server.close();
  }
});
