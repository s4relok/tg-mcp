import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReadinessReport } from '../src/services/doctor.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function baseConfig(overrides = {}) {
  return {
    publicBaseUrl: 'https://celticspear.com',
    mcpPath: '/mcp',
    restBasePath: '/tg-mcp/api',
    openApiPath: '/tg-mcp/openapi.json',
    appAuthToken: 'token',
    telegramApiId: '123',
    telegramApiHash: 'hash',
    telegramSessionFile: './missing.session',
    ...overrides
  };
}

test('createReadinessReport returns warning when setup is incomplete', async () => {
  const report = await createReadinessReport({
    config: {
      ...baseConfig(),
      appAuthToken: '',
      telegramApiId: '',
      telegramApiHash: ''
    },
    store: new MemoryTelegramStore()
  });

  assert.equal(report.status, 'warning');
  assert.ok(report.checks.some((check) => check.name === 'app_auth' && check.status === 'warning'));
  assert.ok(report.checks.some((check) => check.name === 'telegram_sources' && check.status === 'warning'));
  assert.ok(report.checks.some((check) => check.name === 'telegram_credentials' && check.status === 'warning'));
  assert.ok(report.nextSteps.some((step) => step.id === 'set_app_auth'));
  assert.ok(report.nextSteps.some((step) => step.id === 'set_telegram_credentials'));
  assert.ok(report.nextSteps.some((step) => step.id === 'login_telegram'));
  assert.ok(report.nextSteps.some((step) => step.id === 'select_telegram_sources'));
  assert.equal(JSON.stringify(report.nextSteps).includes('secret-hash'), false);
});

test('createReadinessReport can verify Telegram auth with injected client', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-doctor-'));
  const sessionFile = path.join(tmp, 'telegram.session');
  await fs.writeFile(sessionFile, 'session-data');

  let disconnected = false;
  const report = await createReadinessReport({
    config: baseConfig({ sessionFile, telegramSessionFile: sessionFile }),
    store: new MemoryTelegramStore({
      sources: [
        { sourceId: 'chat-1', title: 'Chat', enabled: true, tags: [] }
      ]
    }),
    checkTelegram: true,
    createClient: async () => ({
      disconnect: async () => {
        disconnected = true;
      }
    })
  });

  assert.equal(report.status, 'ok');
  assert.equal(disconnected, true);
  assert.ok(report.checks.some((check) => check.name === 'telegram_auth' && check.status === 'ok'));
  assert.deepEqual(report.nextSteps, [
    {
      id: 'deploy_or_connect',
      reason: 'Core readiness checks are passing.',
      command: 'Deploy the service and connect ChatGPT to the MCP endpoint.'
    }
  ]);
});

test('createReadinessReport validates optional Telegram slash bot config', async () => {
  const missingToken = await createReadinessReport({
    config: baseConfig({
      telegramBotEnabled: true,
      telegramBotToken: '',
      telegramBotAllowedChatIds: ['123']
    }),
    store: new MemoryTelegramStore({
      sources: [{ sourceId: 'chat-1', title: 'Chat', enabled: true, tags: [] }]
    })
  });

  assert.equal(missingToken.status, 'error');
  assert.ok(missingToken.checks.some((check) => check.name === 'telegram_bot' && check.status === 'error'));

  const openBot = await createReadinessReport({
    config: baseConfig({
      telegramBotEnabled: true,
      telegramBotToken: 'token',
      telegramBotAllowedChatIds: []
    }),
    store: new MemoryTelegramStore({
      sources: [{ sourceId: 'chat-1', title: 'Chat', enabled: true, tags: [] }]
    })
  });

  assert.ok(openBot.checks.some((check) => check.name === 'telegram_bot' && check.status === 'warning'));
  assert.ok(openBot.nextSteps.some((step) => step.id === 'restrict_telegram_bot'));
});
