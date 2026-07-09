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
    restBasePath: '/tg-mcp/api',
    openApiPath: '/tg-mcp/openapi.json',
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
    assert.equal(body.restBasePath, '/tg-mcp/api');
  } finally {
    server.close();
  }
});

test('OpenAPI endpoint exposes REST fallback schema', async () => {
  const store = new MemoryTelegramStore();
  const app = createApp({
    config: testConfig(),
    store,
    digestService: createTelegramDigestService(store)
  });
  const server = await listen(app);

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/tg-mcp/openapi.json`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.openapi, '3.1.0');
    assert.ok(body.paths['/tg-mcp/api/digest/daily']);
    assert.ok(body.paths['/tg-mcp/api/search']);
  } finally {
    server.close();
  }
});

test('REST fallback endpoints expose digest service data', async () => {
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'chat-1', title: 'Project Chat', enabled: true, tags: ['work'] }],
    messages: [
      {
        sourceId: 'chat-1',
        messageId: 1,
        date: '2026-07-09T06:00:00.000Z',
        senderName: 'Andrei',
        text: 'Decision: ship digest today'
      },
      {
        sourceId: 'chat-1',
        messageId: 2,
        date: '2026-07-09T07:00:00.000Z',
        senderName: 'Mira',
        text: 'Need to check deployment?'
      }
    ]
  });
  const app = createApp({
    config: testConfig(),
    store,
    digestService: createTelegramDigestService(store)
  });
  const server = await listen(app);

  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/tg-mcp/api`;

    const sources = await (await fetch(`${baseUrl}/sources`)).json();
    assert.equal(sources.sources[0].sourceId, 'chat-1');

    const digest = await (await fetch(`${baseUrl}/digest/daily?date=2026-07-09&timezone=UTC&timelineLimit=1&sourceQuery=project`)).json();
    assert.equal(digest.messageCount, 2);
    assert.equal(digest.timeline.length, 1);
    assert.equal(digest.timelineTruncated, true);

    const sourceSummary = await (await fetch(`${baseUrl}/sources/chat-1/summary?date=2026-07-09&timezone=UTC`)).json();
    assert.equal(sourceSummary.found, true);
    assert.equal(sourceSummary.source.sourceId, 'chat-1');
    assert.equal(sourceSummary.messageCount, 2);

    const search = await (await fetch(`${baseUrl}/search?query=deployment`)).json();
    assert.equal(search.count, 1);

    const context = await (await fetch(`${baseUrl}/messages/context?sourceId=chat-1&messageId=2&before=1`)).json();
    assert.equal(context.before[0].messageId, 1);
  } finally {
    server.close();
  }
});

test('REST fallback honors bearer auth when configured', async () => {
  const store = new MemoryTelegramStore();
  const app = createApp({
    config: { ...testConfig(), appAuthToken: 'secret-token' },
    store,
    digestService: createTelegramDigestService(store)
  });
  const server = await listen(app);

  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/tg-mcp/api/sources`;

    const unauthorized = await fetch(url);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(url, {
      headers: {
        Authorization: 'Bearer secret-token'
      }
    });
    assert.equal(authorized.status, 200);
  } finally {
    server.close();
  }
});

test('admin doctor route is protected and returns readiness report', async () => {
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'chat-1', title: 'Project Chat', enabled: true, tags: [] }]
  });
  const app = createApp({
    config: { ...testConfig(), appAuthToken: 'secret-token', telegramSessionFile: './missing.session' },
    store,
    digestService: createTelegramDigestService(store)
  });
  const server = await listen(app);

  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/admin/doctor`;

    const unauthorized = await fetch(url);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(url, {
      headers: {
        Authorization: 'Bearer secret-token'
      }
    });
    const body = await authorized.json();

    assert.equal(authorized.status, 200);
    assert.ok(['ok', 'warning'].includes(body.status));
    assert.ok(body.checks.some((check) => check.name === 'mongodb'));
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
    assert.ok(names.includes('get_source_summary'));
    assert.ok(names.includes('search_telegram_messages'));

    const result = await client.callTool({ name: 'list_sources', arguments: {} });
    assert.equal(result.structuredContent.sources[0].sourceId, 'chat-1');

    await transport.close();
  } finally {
    server.close();
  }
});
