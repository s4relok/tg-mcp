import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { createTelegramDigestService } from '../src/services/digestService.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';
import { attachBackup } from '../src/backup/integration.js';
import { loadConfig } from '../src/config.js';
import { OAuthScopes } from '../src/http/oauth.js';

test('archive admin/owner/OAuth access is isolated from no-auth clients and rechecks current scopes', { timeout: 20000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-backup-http-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = loadConfig({ BACKUP_DIR: root, APP_AUTH_TOKEN: 'owner-token', MCP_BACKUP_TOOLS_ENABLED: 'true',
    PUBLIC_BASE_URL: 'http://127.0.0.1', CHATGPT_MCP_PATH: '/public-mcp', OAUTH_ENABLED: 'true', OAUTH_ISSUER: 'https://issuer.example.com' });
  const store = new MemoryTelegramStore({ sources: [{ sourceId: '123', title: 'Selected' }, { sourceId: '456', title: 'Other' }],
    messages: [{ sourceId: '123', messageId: 1, date: new Date(), text: 'permanent secret' }] });
  const backup = attachBackup({ config, store });
  const scopes = new Set([OAuthScopes.read, OAuthScopes.backupRead]);
  const verifier = { async verifyAccessToken(token) {
    return { token, clientId: 'test', scopes: [...scopes], expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: new URL(config.oauthResource), extra: { subject: 'test-owner' } };
  } };
  const app = createApp({ config, store, backupService: backup, oauthTokenVerifier: verifier, digestService: createTelegramDigestService(store) });
  const server = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/admin/backups/123`)).status, 401);
  const enabled = await fetch(`${base}/admin/backups/123/enable`, { method: 'POST', headers: { Authorization: 'Bearer owner-token' } });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).sourceId, '123');
  await store.setSourceEnabled('123', false);
  const reader = await fetch(`${base}/admin/backups/123/search?query=secret`, { headers: { Authorization: 'Bearer owner-token' } });
  assert.equal((await reader.json()).messages.length, 1);

  async function connect(route, token) {
    const client = new Client({ name: 'backup-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(base + route), {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} }
    });
    await client.connect(transport);
    t.after(() => client.close());
    return client;
  }
  const anonymous = await connect('/public-mcp');
  assert.ok(!(await anonymous.listTools()).tools.some((tool) => tool.name.includes('backup')));
  const owner = await connect('/mcp', 'owner-token');
  assert.ok((await owner.listTools()).tools.some((tool) => tool.name === 'get_backup_media'));
  const oauth = await connect(config.oauthMcpPath, 'oauth-token');
  const search = await oauth.callTool({ name: 'search_source_backup', arguments: { sourceId: '123', query: 'secret' } });
  assert.equal(search.structuredContent.messages.length, 1);
  const mutation = await oauth.callTool({ name: 'pause_source_backup', arguments: { sourceId: '123' } });
  assert.equal(mutation.isError, true);
  assert.ok(mutation._meta['mcp/www_authenticate']);
  scopes.delete(OAuthScopes.backupRead);
  const revoked = await oauth.callTool({ name: 'get_source_backup_status', arguments: { sourceId: '123' } });
  assert.equal(revoked.isError, true);
  scopes.add(OAuthScopes.backupManage);
  const pause = await oauth.callTool({ name: 'pause_source_backup', arguments: { sourceId: '123' } });
  assert.equal(pause.structuredContent.captureEnabled, false);
});
