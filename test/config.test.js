import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertSafeRuntimeConfig, loadConfigFromProcessEnv } from '../src/config.js';

test('loadConfigFromProcessEnv reads an explicit env file with process env precedence', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-config-'));
  const envFile = path.join(tmp, '.env.production');
  await fs.writeFile(envFile, [
    'NODE_ENV=production',
    'PORT=9999',
    'APP_AUTH_TOKEN=file-token',
    'TELEGRAM_API_ID=123',
    'TELEGRAM_API_HASH=hash',
    'TELEGRAM_SESSION_FILE=/srv/tg-mcp/shared/sessions/telegram.session',
    'OPENAI_API_KEY=file-openai-key',
    'OPENAI_TRANSCRIPTION_ENABLED=true',
    'OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe',
    'AUDIO_TRANSCRIPTION_BATCH_SIZE=2',
    ''
  ].join('\n'));

  const keys = [
    'NODE_ENV',
    'PORT',
    'APP_AUTH_TOKEN',
    'TELEGRAM_API_ID',
    'TELEGRAM_API_HASH',
    'TELEGRAM_SESSION_FILE',
    'OPENAI_API_KEY',
    'OPENAI_TRANSCRIPTION_ENABLED',
    'OPENAI_TRANSCRIPTION_MODEL',
    'AUDIO_TRANSCRIPTION_BATCH_SIZE'
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) {
    delete process.env[key];
  }
  process.env.PORT = '3015';

  try {
    const config = loadConfigFromProcessEnv({ envFile });

    assert.equal(config.nodeEnv, 'production');
    assert.equal(config.port, 3015);
    assert.equal(config.appAuthToken, 'file-token');
    assert.equal(config.telegramApiId, '123');
    assert.equal(config.telegramSessionFile, '/srv/tg-mcp/shared/sessions/telegram.session');
    assert.equal(config.openAiApiKey, 'file-openai-key');
    assert.equal(config.openAiTranscriptionEnabled, true);
    assert.equal(config.openAiTranscriptionModel, 'gpt-4o-mini-transcribe');
    assert.equal(config.audioTranscriptionBatchSize, 2);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
});

test('loadConfigFromProcessEnv rejects a missing explicit env file', () => {
  assert.throws(
    () => loadConfigFromProcessEnv({ envFile: path.join(os.tmpdir(), 'missing-tg-mcp.env') }),
    /Env file not found/
  );
});

test('assertSafeRuntimeConfig requires auth in production', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({
      nodeEnv: 'production',
      appAuthToken: '',
      allowUnauthenticated: false
    }),
    /APP_AUTH_TOKEN is required/
  );

  assert.doesNotThrow(() => assertSafeRuntimeConfig({
    nodeEnv: 'production',
    appAuthToken: 'token',
    allowUnauthenticated: false
  }));

  assert.doesNotThrow(() => assertSafeRuntimeConfig({
    nodeEnv: 'production',
    appAuthToken: '',
    allowUnauthenticated: true
  }));
});
