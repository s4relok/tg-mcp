import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertSafeRuntimeConfig, loadConfig, loadConfigFromProcessEnv } from '../src/config.js';

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
    'AUDIO_TRANSCRIPTION_SOURCE_IDS=saved,archive',
    'AUDIO_TRANSCRIPTION_SOURCE_TAGS=voice',
    'AUDIO_TRANSCRIPTION_INTERVAL_SECONDS=3600',
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
    'AUDIO_TRANSCRIPTION_SOURCE_IDS',
    'AUDIO_TRANSCRIPTION_SOURCE_TAGS',
    'AUDIO_TRANSCRIPTION_INTERVAL_SECONDS',
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
    assert.deepEqual(config.audioTranscriptionSourceIds, ['saved', 'archive']);
    assert.deepEqual(config.audioTranscriptionSourceTags, ['voice']);
    assert.equal(config.audioTranscriptionIntervalSeconds, 3600);
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

test('loadConfig exposes fail-closed source management and scheduler defaults', () => {
  const defaults = loadConfig({ TELEGRAM_SYNC_INTERVAL_SECONDS: '420' });
  assert.equal(defaults.sourceDefaultSyncIntervalSeconds, 420);
  assert.equal(defaults.sourceDefaultHistoryDepthDays, 30);
  assert.equal(defaults.sourceDefaultIncludeMedia, true);
  assert.equal(defaults.sourceDefaultPriority, 50);
  assert.equal(defaults.mcpSourceManagementEnabled, false);

  const configured = loadConfig({
    SOURCE_DEFAULT_SYNC_INTERVAL_SECONDS: '900',
    SOURCE_DEFAULT_INCLUDE_MEDIA: 'false',
    MCP_SOURCE_MANAGEMENT_ENABLED: 'true'
  });
  assert.equal(configured.sourceDefaultSyncIntervalSeconds, 900);
  assert.equal(configured.sourceDefaultIncludeMedia, false);
  assert.equal(configured.mcpSourceManagementEnabled, true);
});

test('loadConfig exposes fail-closed OAuth defaults and derived resource metadata URL', () => {
  const defaults = loadConfig({
    PUBLIC_BASE_URL: 'https://example.com/base'
  });
  assert.equal(defaults.oauthEnabled, false);
  assert.equal(defaults.oauthMcpPath, '/tg-mcp/oauth-mcp');
  assert.equal(defaults.oauthResource, 'https://example.com/tg-mcp/oauth-mcp');
  assert.equal(
    defaults.oauthProtectedResourceMetadataUrl,
    'https://example.com/.well-known/oauth-protected-resource/tg-mcp/oauth-mcp'
  );
  assert.deepEqual(defaults.oauthJwtAlgorithms, ['RS256', 'ES256']);
  assert.deepEqual(defaults.oauthAllowedSubjects, []);
});

test('assertSafeRuntimeConfig validates enabled OAuth configuration', () => {
  const missing = loadConfig({
    NODE_ENV: 'development',
    OAUTH_ENABLED: 'true'
  });
  assert.throws(() => assertSafeRuntimeConfig(missing), /OAUTH_ISSUER is required/);

  const valid = loadConfig({
    NODE_ENV: 'development',
    PUBLIC_BASE_URL: 'http://127.0.0.1:3010',
    OAUTH_ENABLED: 'true',
    OAUTH_ISSUER: 'http://127.0.0.1:4010',
    OAUTH_JWKS_URL: 'http://127.0.0.1:4010/.well-known/jwks.json',
    OAUTH_ALLOWED_SUBJECTS: 'owner-1,owner-2'
  });
  assert.doesNotThrow(() => assertSafeRuntimeConfig(valid));
  assert.deepEqual(valid.oauthAllowedSubjects, ['owner-1', 'owner-2']);

  assert.throws(
    () => assertSafeRuntimeConfig({
      ...valid,
      oauthJwtAlgorithms: ['HS256']
    }),
    /only asymmetric/
  );
  assert.throws(
    () => assertSafeRuntimeConfig({
      ...valid,
      oauthMcpPath: valid.mcpPath
    }),
    /must be different/
  );
});
