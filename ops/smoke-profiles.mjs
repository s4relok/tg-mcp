import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parse as parseDotenv } from 'dotenv';

const envFile = process.env.ENV_FILE || process.env.TG_MCP_ENV_FILE || '';
const fileEnv = envFile ? parseDotenv(fs.readFileSync(envFile, 'utf8')) : {};
const baseUrl = String(process.env.BASE_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
const mcpPath = process.env.MCP_PATH || fileEnv.MCP_PATH || '/mcp';
const token = process.env.AUTH_TOKEN || process.env.APP_AUTH_TOKEN || fileEnv.APP_AUTH_TOKEN;
if (!token) throw new Error('An owner token is required');

const client = new Client({ name: 'tg-mcp-profiles-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${mcpPath}`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } }
});

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed: ${result.content.filter((item) => item.type === 'text').map((item) => item.text).join(' ')}`);
  }
  return result.structuredContent;
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['get_telegram_profile', 'get_contact_birthdays']) {
    assert.ok(tools.some((tool) => tool.name === name), `${name} is not enabled`);
  }
  const own = await call('get_telegram_profile', { userId: 'me' });
  assert.ok(own.profile.userId);
  assert.ok(['visible', 'not_set_or_not_visible'].includes(own.profile.birthdayStatus));
  const birthdays = await call('get_contact_birthdays');
  assert.equal(birthdays.count, birthdays.contacts.length);
  assert.deepEqual(birthdays.window, { daysBefore: 1, daysAfter: 1, determinedBy: 'telegram' });
  if (birthdays.count) {
    const contact = await call('get_telegram_profile', { userId: birthdays.contacts[0].userId });
    assert.equal(contact.profile.userId, birthdays.contacts[0].userId);
  }
  console.log(JSON.stringify({
    status: 'ok', profileRead: true, birthdayListRead: true,
    birthdayCount: birthdays.count, contactIdLookupChecked: birthdays.count > 0
  }, null, 2));
} finally {
  await transport.close();
}
