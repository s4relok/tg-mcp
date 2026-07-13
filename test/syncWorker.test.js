import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelegramSyncWorker } from '../src/telegram/syncWorker.js';

function baseConfig(overrides = {}) {
  return {
    telegramSyncEnabled: true,
    telegramSyncIntervalSeconds: 300,
    telegramSyncOnStart: false,
    allowedSourceIds: [],
    telegramSyncLimit: 10,
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
    logger: silentLogger(),
    setTimer: () => {
      timerCalled = true;
    }
  });

  const result = worker.start();

  assert.equal(result.started, false);
  assert.equal(timerCalled, false);
});

test('Telegram sync worker runOnce syncs and disconnects client', async () => {
  let disconnected = false;
  const client = {
    disconnect: async () => {
      disconnected = true;
    }
  };
  const worker = createTelegramSyncWorker({
    config: baseConfig(),
    store: { name: 'store' },
    logger: silentLogger(),
    createClient: async () => client,
    syncMessages: async ({ client: receivedClient, store, config }) => {
      assert.equal(receivedClient, client);
      assert.deepEqual(store, { name: 'store' });
      assert.equal(config.telegramSyncLimit, 10);
      return { sourceCount: 1, messageCount: 2 };
    }
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, { sourceCount: 1, messageCount: 2 });
  assert.equal(disconnected, true);
});

test('Telegram sync worker runs post-sync hook only when audio messages were synced', async () => {
  let syncRuns = 0;
  let postSyncCalls = 0;
  const worker = createTelegramSyncWorker({
    config: baseConfig(),
    store: {},
    logger: silentLogger(),
    createClient: async () => ({
      disconnect: async () => {}
    }),
    syncMessages: async () => {
      syncRuns += 1;
      return {
        sourceCount: 1,
        messageCount: 2,
        audioMessageCount: syncRuns === 1 ? 0 : 1
      };
    },
    afterSync: async () => {
      postSyncCalls += 1;
    }
  });

  await worker.runOnce();
  assert.equal(postSyncCalls, 0);

  await worker.runOnce();
  assert.equal(postSyncCalls, 1);
});

test('Telegram sync worker reports post-sync hook errors without failing sync result', async () => {
  const warnings = [];
  const worker = createTelegramSyncWorker({
    config: baseConfig(),
    store: {},
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      }
    },
    createClient: async () => ({
      disconnect: async () => {}
    }),
    syncMessages: async () => ({
      sourceCount: 1,
      messageCount: 1,
      audioMessageCount: 1
    }),
    afterSync: async () => {
      throw new Error('transcription busy');
    }
  });

  const result = await worker.runOnce();

  assert.equal(result.audioMessageCount, 1);
  assert.ok(warnings.some((message) => /transcription busy/.test(message)));
});

test('Telegram sync worker reports sync errors without throwing', async () => {
  const warnings = [];
  const worker = createTelegramSyncWorker({
    config: baseConfig(),
    store: {},
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      }
    },
    createClient: async () => {
      throw new Error('missing session');
    }
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, { error: 'missing session' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing session/);
});
