import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryTelegramStore } from '../src/storage/memoryStore.js';
import { createTelegramSyncCoordinator } from '../src/telegram/sourceSyncCoordinator.js';

function config(overrides = {}) {
  return {
    allowedSourceIds: [],
    telegramSyncLimit: 100,
    telegramSyncMaxLimit: 1000,
    sourceDefaultSyncIntervalSeconds: 300,
    sourceDefaultHistoryDepthDays: 30,
    sourceDefaultIncludeMedia: true,
    sourceDefaultIncludeReplies: true,
    sourceDefaultIncludeForwardedPosts: true,
    sourceDefaultPriority: 50,
    sourceSchedulerBatchSize: 10,
    sourceMutationBatchLimit: 25,
    sourceSyncLockSeconds: 900,
    ...overrides
  };
}

test('coordinator locks, syncs, schedules, disconnects, and runs post-sync work', async () => {
  const now = new Date('2026-07-14T12:00:00.000Z');
  const store = new MemoryTelegramStore({
    sources: [{
      sourceId: 'channel-1',
      title: 'Game News',
      username: 'game_news',
      type: 'Channel',
      enabled: true,
      settings: { syncIntervalSeconds: 600, historyDepthDays: 7 }
    }]
  });
  let disconnected = false;
  let receivedArgs = null;
  let postSyncCalls = 0;
  const coordinator = createTelegramSyncCoordinator({
    config: config(),
    store,
    now: () => new Date(now),
    createClient: async () => ({
      disconnect: async () => {
        disconnected = true;
      }
    }),
    syncMessages: async (args) => {
      receivedArgs = args;
      return {
        sourceCount: 1,
        messageCount: 2,
        audioMessageCount: 1,
        sources: [{ sourceId: 'channel-1', messageCount: 2 }]
      };
    },
    afterSync: async () => {
      postSyncCalls += 1;
      return { completed: 1 };
    }
  });

  const result = await coordinator.run({
    sourceIds: ['channel-1'],
    backfillDays: 20,
    actor: 'test'
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.messageCount, 2);
  assert.equal(result.requestedBackfillDays, 20);
  assert.equal(result.afterSyncResult.completed, 1);
  assert.equal(receivedArgs.minDate.toISOString(), '2026-07-07T12:00:00.000Z');
  assert.equal(disconnected, true);
  assert.equal(postSyncCalls, 1);

  const [source] = await store.listSources({ sourceIds: ['channel-1'] });
  assert.equal(new Date(source.nextSyncAt).toISOString(), '2026-07-14T12:10:00.000Z');
  assert.equal(source.lastSyncError, null);
  assert.equal(source.syncLockUntil, undefined);
});

test('coordinator refuses disabled sources and the ALLOWED_SOURCE_IDS ceiling', async () => {
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'disabled', title: 'Disabled', enabled: false },
      { sourceId: 'outside', title: 'Outside', enabled: true }
    ]
  });
  let clients = 0;
  const coordinator = createTelegramSyncCoordinator({
    config: config({ allowedSourceIds: ['allowed'] }),
    store,
    createClient: async () => {
      clients += 1;
      return { disconnect: async () => {} };
    }
  });

  const result = await coordinator.run({ sourceIds: ['disabled', 'outside'] });
  assert.equal(result.sourceCount, 0);
  assert.equal(clients, 0);
  assert.ok(result.skipped.some((item) => item.sourceId === 'disabled' && item.reason === 'disabled'));
  assert.ok(result.skipped.some((item) => item.sourceId === 'outside' && item.reason === 'outside_allowed_source_ids'));
});

test('coordinator records source errors and releases the lease', async () => {
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'channel-1', title: 'Game News', enabled: true }]
  });
  const coordinator = createTelegramSyncCoordinator({
    config: config(),
    store,
    createClient: async () => {
      throw new Error('missing session');
    },
    logger: { info() {}, warn() {} }
  });

  const result = await coordinator.run({ sourceIds: ['channel-1'] });
  assert.equal(result.status, 'error');
  assert.match(result.errors[0].error, /missing session/);
  const [source] = await store.listSources({ sourceIds: ['channel-1'] });
  assert.equal(source.lastSyncError, 'missing session');
  assert.equal(source.syncLockUntil, undefined);
});

test('due sources are ordered by schedule then priority', async () => {
  const due = new Date('2026-07-14T11:00:00.000Z');
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'low', title: 'Low', enabled: true, nextSyncAt: due, settings: { priority: 10 } },
      { sourceId: 'high', title: 'High', enabled: true, nextSyncAt: due, settings: { priority: 90 } }
    ]
  });
  const sources = await store.listSourcesDueForSync({
    now: new Date('2026-07-14T12:00:00.000Z'),
    limit: 10
  });
  assert.deepEqual(sources.map((source) => source.sourceId), ['high', 'low']);
});
