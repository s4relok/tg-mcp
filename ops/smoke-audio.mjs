import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parse as parseDotenv } from 'dotenv';

function positiveInteger(value, name) {
  if (!/^\d+$/.test(String(value || '')) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

const envFile = process.env.ENV_FILE || process.env.TG_MCP_ENV_FILE || '';
const fileEnv = envFile ? parseDotenv(fs.readFileSync(envFile, 'utf8')) : {};
const baseUrl = String(process.env.BASE_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
const mcpPath = process.env.MCP_PATH || fileEnv.MCP_PATH || '/mcp';
const sourceId = String(process.env.SOURCE_ID || '').trim();
const messageId = positiveInteger(process.env.MESSAGE_ID, 'MESSAGE_ID');
const expectedSize = process.env.EXPECTED_SIZE
  ? positiveInteger(process.env.EXPECTED_SIZE, 'EXPECTED_SIZE')
  : null;
const authToken = process.env.AUTH_TOKEN
  || process.env.APP_AUTH_TOKEN
  || fileEnv.APP_AUTH_TOKEN
  || '';

if (!sourceId) {
  throw new Error('SOURCE_ID is required');
}

const client = new Client({ name: 'tg-mcp-audio-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(
  new URL(`${baseUrl}${mcpPath}`),
  authToken
    ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } }
    : undefined
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === 'get_telegram_audio')) {
    throw new Error('get_telegram_audio is not enabled on this MCP endpoint');
  }
  const result = await client.callTool({
    name: 'get_telegram_audio',
    arguments: { sourceId, messageIds: [messageId] }
  });
  if (result.isError) {
    throw new Error('get_telegram_audio returned an MCP error');
  }
  const audio = result.content.find((item) => item.type === 'audio');
  if (!audio) {
    throw new Error('get_telegram_audio returned no audio content');
  }
  const bytes = Buffer.from(audio.data, 'base64');
  if (!bytes.length) {
    throw new Error('get_telegram_audio returned empty audio bytes');
  }
  if (expectedSize !== null && bytes.length !== expectedSize) {
    throw new Error(`Audio size mismatch: expected ${expectedSize}, received ${bytes.length}`);
  }
  console.log(JSON.stringify({
    tool: 'get_telegram_audio',
    sourceId,
    messageId,
    mimeType: audio.mimeType,
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }, null, 2));
} finally {
  await transport.close();
}
