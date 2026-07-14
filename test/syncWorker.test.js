import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelegramSyncWorker } from '../src/telegram/syncWorker.js';

function baseConfig(overrides = {}) {
  return {
    telegramSyncEnabled: true,
    telegramSyncOnStart: false,
    sourceSchedulerPollIntervalSeconds: 30,
    ...overrides
  };
}

function silentLogger() {
  return {
    info() {},
    warn() {}
  };
}

test('Telegram sync worker does not start when disabled', () => {
  let timerCalled = false;
  const worker = createTelegramSyncWorker({
    config: baseConfig({ telegramSyncEnabled: false }),
    store: {},
    coordinator: { runDue: async () => ({}) },
    logger: silentLogger(),
    setTimer: () => {
      timerCalled = true;
    }
  });

  const result = worker.start();
  assert.equal(result.started, false);
  assert.equal(timerCalled, false);
});

test('Telegram sync worker delegates a tick to the shared coordinator', async () => {
  let calls = 0;
  const expected = { sourceCount: 1, messageCount: 2, audioMessageCount: 0 };
  const worker = createTelegramSyncWorker({
    config: baseConfig(),
    store: {},
    coordinator: {
      runDue: async () => {
        calls += 1;
        return expected;
      }
    },
    logger: silentLogger()
  });

  const result = await worker.runOnce();
  assert.deepEqual(result, expected);
  assert.equal(calls, 1);
});

test('Telegram sync worker reports coordinator errors without throwing', async () => {
  const warnings = [];
  const worker = createTelegramSyncWorker({
    config: baseConfig(),
    store: {},
    coordinator: {
      runDue: async () => {
        throw new Error('missing session');
      }
    },
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      }
    }
  });

  const result = await worker.runOnce();
  assert.deepEqual(result, { error: 'missing session' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing session/);
});
