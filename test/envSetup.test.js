import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parse as parseDotenv } from 'dotenv';

import { setupEnvFile } from '../src/services/envSetup.js';

async function readEnv(file) {
  return parseDotenv(await fs.readFile(file, 'utf8'));
}

test('setupEnvFile creates production env with generated auth token', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-env-'));
  const envFile = path.join(tmp, '.env');

  const result = await setupEnvFile({
    envFile,
    production: true,
    tokenFactory: () => 'fixed-token'
  });
  const values = await readEnv(envFile);

  assert.equal(result.existed, false);
  assert.equal(result.backupFile, null);
  assert.deepEqual(result.generatedKeys, ['APP_AUTH_TOKEN']);
  assert.equal(JSON.stringify(result).includes('fixed-token'), false);
  assert.equal(values.NODE_ENV, 'production');
  assert.equal(values.TELEGRAM_SESSION_FILE, '/srv/tg-mcp/shared/sessions/telegram.session');
  assert.equal(values.APP_AUTH_TOKEN, 'fixed-token');
});

test('setupEnvFile preserves existing protected secrets when force is used', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-env-'));
  const envFile = path.join(tmp, '.env');
  await fs.writeFile(envFile, [
    'NODE_ENV=development',
    'TELEGRAM_API_ID=123',
    'TELEGRAM_API_HASH=hash',
    'APP_AUTH_TOKEN=keep-token',
    ''
  ].join('\n'));

  const result = await setupEnvFile({
    envFile,
    production: true,
    force: true,
    tokenFactory: () => 'new-token',
    now: new Date('2026-07-09T12:00:00.000Z')
  });
  const values = await readEnv(envFile);
  const backup = await readEnv(result.backupFile);

  assert.equal(result.existed, true);
  assert.equal(path.basename(result.backupFile), '.env.before-setup-20260709T120000Z');
  assert.equal(values.NODE_ENV, 'production');
  assert.equal(values.TELEGRAM_API_ID, '123');
  assert.equal(values.TELEGRAM_API_HASH, 'hash');
  assert.equal(values.APP_AUTH_TOKEN, 'keep-token');
  assert.equal(backup.NODE_ENV, 'development');
});

test('setupEnvFile applies explicit values and preserves extras', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-env-'));
  const envFile = path.join(tmp, '.env');
  await fs.writeFile(envFile, [
    'CUSTOM_FLAG=yes',
    'APP_AUTH_TOKEN=old-token',
    ''
  ].join('\n'));

  const result = await setupEnvFile({
    envFile,
    values: {
      APP_AUTH_TOKEN: 'explicit-token',
      TELEGRAM_API_ID: '999',
      CUSTOM_FLAG: 'no'
    },
    tokenFactory: () => 'generated-token'
  });
  const values = await readEnv(envFile);

  assert.equal(values.APP_AUTH_TOKEN, 'explicit-token');
  assert.equal(values.TELEGRAM_API_ID, '999');
  assert.equal(values.CUSTOM_FLAG, 'no');
  assert.ok(result.updatedKeys.includes('APP_AUTH_TOKEN'));
  assert.ok(result.updatedKeys.includes('CUSTOM_FLAG'));
});
