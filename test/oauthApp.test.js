import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

import { createApp } from '../src/app.js';
import { OAuthScopes } from '../src/http/oauth.js';
import { createTelegramDigestService } from '../src/services/digestService.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function clientFor(url, token) {
  const client = new Client({ name: `oauth-${token}`, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` }
    }
  });
  return { client, transport };
}

async function readJsonRpcResponse(response) {
  const text = await response.text();
  if (response.headers.get('content-type').includes('text/event-stream')) {
    const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
    return JSON.parse(dataLine.slice('data:'.length).trim());
  }
  return JSON.parse(text);
}

test('OAuth MCP publishes metadata, challenges clients, and enforces current tool scopes', { timeout: 15000 }, async () => {
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'enabled-1', title: 'Enabled Channel', type: 'Channel', enabled: true, tags: [] },
      {
        sourceId: 'disabled-1',
        title: 'Game Industry Wire',
        username: 'gameindustrywire',
        type: 'Channel',
        enabled: false,
        tags: []
      }
    ]
  });
  const tokenScopes = new Map([
    ['reader-token', [OAuthScopes.read]],
    ['owner-token', [
      OAuthScopes.read,
      OAuthScopes.sourcesRead,
      OAuthScopes.sourcesManage,
      OAuthScopes.syncRun
    ]]
  ]);
  const verifier = {
    async verifyAccessToken(token) {
      const scopes = tokenScopes.get(token);
      if (!scopes) {
        throw new InvalidTokenError('Unknown test token');
      }
      return {
        token,
        clientId: 'chatgpt-client',
        scopes: [...scopes],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: new URL('http://127.0.0.1/tg-mcp/oauth-mcp'),
        extra: { subject: token === 'owner-token' ? 'owner-1' : 'reader-1' }
      };
    }
  };
  const config = {
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1',
    mcpPath: '/mcp',
    chatGptMcpPath: '',
    oauthEnabled: true,
    oauthMcpPath: '/tg-mcp/oauth-mcp',
    oauthResource: 'http://127.0.0.1/tg-mcp/oauth-mcp',
    oauthProtectedResourceMetadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource/tg-mcp/oauth-mcp',
    oauthIssuer: 'https://issuer.example.com',
    oauthResourceDocumentation: 'https://example.com/docs/tg-mcp',
    restBasePath: '/tg-mcp/api',
    openApiPath: '/tg-mcp/openapi.json',
    allowedHosts: ['127.0.0.1', 'localhost'],
    appAuthToken: '',
    mcpSourceManagementEnabled: true,
    sourceMutationBatchLimit: 25,
    telegramSyncMaxLimit: 1000
  };
  const app = createApp({
    config,
    store,
    digestService: createTelegramDigestService(store),
    oauthTokenVerifier: verifier
  });
  const server = await listen(app);
  const activeTransports = [];

  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const metadataResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    const metadata = await metadataResponse.json();
    assert.equal(metadataResponse.status, 200);
    assert.equal(metadata.resource, config.oauthResource);
    assert.deepEqual(metadata.authorization_servers, [config.oauthIssuer]);
    assert.deepEqual(metadata.scopes_supported, [
      OAuthScopes.read,
      OAuthScopes.sourcesRead,
      OAuthScopes.sourcesManage,
      OAuthScopes.syncRun
    ]);

    const pathMetadataResponse = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/tg-mcp/oauth-mcp`
    );
    assert.equal(pathMetadataResponse.status, 200);

    const unauthorized = await fetch(`${baseUrl}${config.oauthMcpPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' }
        }
      })
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate'), /resource_metadata=/);
    assert.match(unauthorized.headers.get('www-authenticate'), /scope="telegram:read"/);

    const reader = clientFor(`${baseUrl}${config.oauthMcpPath}`, 'reader-token');
    activeTransports.push(reader.transport);
    await reader.client.connect(reader.transport);
    const readerTools = await reader.client.listTools();
    const enableTool = readerTools.tools.find((tool) => tool.name === 'enable_source');
    assert.ok(enableTool);
    assert.deepEqual(enableTool._meta.securitySchemes[0], {
      type: 'oauth2',
      scopes: [OAuthScopes.read, OAuthScopes.sourcesRead, OAuthScopes.sourcesManage]
    });
    const crossedIdentityResponse = await fetch(`${baseUrl}${config.oauthMcpPath}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': reader.transport.sessionId
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 98,
        method: 'tools/list',
        params: {}
      })
    });
    assert.equal(crossedIdentityResponse.status, 400);

    const rawToolsResponse = await fetch(`${baseUrl}${config.oauthMcpPath}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer reader-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': reader.transport.sessionId
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/list',
        params: {}
      })
    });
    const rawTools = await readJsonRpcResponse(rawToolsResponse);
    const rawEnableTool = rawTools.result.tools.find((tool) => tool.name === 'enable_source');
    assert.deepEqual(rawEnableTool.securitySchemes, rawEnableTool._meta.securitySchemes);

    const enabledSources = await reader.client.callTool({ name: 'list_sources', arguments: {} });
    assert.deepEqual(
      enabledSources.structuredContent.sources.map((source) => source.sourceId),
      ['enabled-1']
    );
    const disabledEscalation = await reader.client.callTool({
      name: 'list_sources',
      arguments: { includeDisabled: true }
    });
    assert.equal(disabledEscalation.isError, true);
    assert.match(
      disabledEscalation._meta['mcp/www_authenticate'][0],
      /insufficient_scope/
    );
    const mutationEscalation = await reader.client.callTool({
      name: 'enable_source',
      arguments: { sourceIds: ['disabled-1'] }
    });
    assert.equal(mutationEscalation.isError, true);

    const owner = clientFor(`${baseUrl}${config.oauthMcpPath}`, 'owner-token');
    activeTransports.push(owner.transport);
    await owner.client.connect(owner.transport);
    const allSources = await owner.client.callTool({
      name: 'list_sources',
      arguments: { includeDisabled: true }
    });
    assert.deepEqual(
      allSources.structuredContent.sources.map((source) => source.sourceId),
      ['enabled-1', 'disabled-1']
    );
    const enabled = await owner.client.callTool({
      name: 'enable_source',
      arguments: { sourceIds: ['disabled-1'], tags: ['gamedev'] }
    });
    assert.equal(enabled.structuredContent.status, 'updated');
    assert.equal(store.sourceAudit[0].actor, 'mcp:oauth:owner-1');

    tokenScopes.set('owner-token', [OAuthScopes.read]);
    const downgraded = await owner.client.callTool({
      name: 'disable_source',
      arguments: { sourceIds: ['disabled-1'] }
    });
    assert.equal(downgraded.isError, true);
    assert.match(downgraded._meta['mcp/www_authenticate'][0], /telegram:sources:manage/);
  } finally {
    await Promise.allSettled(activeTransports.map((transport) => transport.close()));
    await new Promise((resolve) => server.close(resolve));
  }
});
