import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { OAuthScopes, getSupportedOAuthScopes } from '../src/http/oauth.js';
import { createTelegramDigestService } from '../src/services/digestService.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

const profileNames = ['get_telegram_profile', 'get_contact_birthdays'];

async function fixture(t, env = {}) {
  const config = loadConfig({
    PUBLIC_BASE_URL: 'http://127.0.0.1', APP_AUTH_TOKEN: 'owner-token',
    CHATGPT_MCP_PATH: '/public-mcp', MCP_PROFILE_TOOLS_ENABLED: 'true',
    ...env
  });
  const calls = [];
  const store = new MemoryTelegramStore();
  let scopes = [OAuthScopes.read, OAuthScopes.sourcesRead];
  const app = createApp({
    config, store, digestService: createTelegramDigestService(store),
    profileService: {
      async getProfile(args) { calls.push(args); return { profile: { userId: args.userId, birthday: null } }; },
      async getContactBirthdays() { calls.push('birthdays'); return { count: 0, contacts: [] }; }
    },
    oauthTokenVerifier: {
      async verifyAccessToken(token) {
        return { token, clientId: 'test', scopes: [...scopes], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { subject: 'owner' } };
      }
    }
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const transports = [];
  t.after(async () => {
    await Promise.allSettled(transports.map((transport) => transport.close()));
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    calls,
    setScopes(value) { scopes = value; },
    async connect(path = '/mcp', token = 'owner-token') {
      const client = new Client({ name: 'profile-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}${path}`), {
        requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      });
      transports.push(transport);
      await client.connect(transport);
      return client;
    }
  };
}

test('owner can read profiles and birthdays with source management disabled', async (t) => {
  const { connect, calls } = await fixture(t);
  const client = await connect();
  const { tools } = await client.listTools();
  for (const name of profileNames) {
    assert.equal(tools.find((tool) => tool.name === name).annotations.readOnlyHint, true);
  }
  const profile = await client.callTool({ name: profileNames[0], arguments: { userId: '@anna' } });
  assert.equal(profile.structuredContent.profile.userId, '@anna');
  const birthdays = await client.callTool({ name: profileNames[1], arguments: {} });
  assert.equal(birthdays.structuredContent.count, 0);
  assert.deepEqual(calls, [{ userId: '@anna' }, 'birthdays']);
});

for (const scenario of [
  { name: 'public endpoint', env: {}, path: '/public-mcp' },
  { name: 'unauthenticated main endpoint', env: { APP_AUTH_TOKEN: '' }, path: '/mcp' },
  { name: 'disabled feature flag', env: { MCP_PROFILE_TOOLS_ENABLED: 'false' }, path: '/mcp' }
]) {
  test(`profiles and birthdays are unavailable on ${scenario.name}`, async (t) => {
    const { connect, calls } = await fixture(t, scenario.env);
    const client = await connect(scenario.path);
    const { tools } = await client.listTools();
    for (const name of profileNames) {
      assert.equal(tools.some((tool) => tool.name === name), false);
      const result = await client.callTool({ name, arguments: { userId: 'me' } });
      assert.equal(result.isError, true);
    }
    assert.deepEqual(calls, []);
  });
}

test('OAuth profile tools require sources:read on every call, including after a scope downgrade', async (t) => {
  const { connect, calls, setScopes } = await fixture(t, { OAUTH_ENABLED: 'true' });
  const client = await connect('/tg-mcp/oauth-mcp');
  const { tools } = await client.listTools();
  for (const name of profileNames) {
    const tool = tools.find((item) => item.name === name);
    assert.deepEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: [OAuthScopes.read, OAuthScopes.sourcesRead] }]);
    const result = await client.callTool({ name, arguments: name === profileNames[0] ? { userId: 'me' } : {} });
    assert.notEqual(result.isError, true);
  }
  setScopes([OAuthScopes.read]);
  for (const name of profileNames) {
    const result = await client.callTool({ name, arguments: name === profileNames[0] ? { userId: 'me' } : {} });
    assert.equal(result.isError, true);
    assert.match(result._meta['mcp/www_authenticate'][0], /telegram:sources:read/);
  }
  assert.equal(calls.length, 2);
});

test('profile configuration defaults off and advertises only its required OAuth scopes', () => {
  assert.equal(loadConfig({}).mcpProfileToolsEnabled, false);
  const config = loadConfig({ MCP_PROFILE_TOOLS_ENABLED: 'true' });
  assert.equal(config.mcpProfileToolsEnabled, true);
  assert.deepEqual(getSupportedOAuthScopes(config), [OAuthScopes.read, OAuthScopes.sourcesRead]);
});
