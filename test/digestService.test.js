import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelegramDigestService } from '../src/services/digestService.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function createFixtureService() {
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'chat-1', title: 'Project Chat', type: 'Channel', enabled: true, tags: ['work'] },
      { sourceId: 'chat-2', title: 'Muted Chat', type: 'Chat', enabled: false, tags: ['muted'] }
    ],
    messages: [
      {
        sourceId: 'chat-1',
        messageId: 1,
        date: '2026-07-09T06:00:00.000Z',
        senderName: 'Andrei',
        text: 'Decision: ship the digest MCP today. https://example.com/spec'
      },
      {
        sourceId: 'chat-1',
        messageId: 2,
        date: '2026-07-09T07:00:00.000Z',
        senderName: 'Mira',
        text: 'Need to check Telegram sync before deploy?'
      },
      {
        sourceId: 'chat-2',
        messageId: 1,
        date: '2026-07-09T08:00:00.000Z',
        senderName: 'Noise',
        text: 'This disabled source should not appear.'
      }
    ]
  });

  return createTelegramDigestService(store);
}

function createFixtureStore() {
  return new MemoryTelegramStore({
    sources: [
      { sourceId: 'chat-1', title: 'Project Chat', type: 'Channel', enabled: true, tags: ['work'] },
      { sourceId: 'chat-2', title: 'Muted Chat', type: 'Chat', enabled: false, tags: ['muted'] }
    ],
    messages: [
      {
        sourceId: 'chat-1',
        messageId: 1,
        date: '2026-07-09T06:00:00.000Z',
        senderName: 'Andrei',
        text: 'Decision: ship the digest MCP today. https://example.com/spec'
      },
      {
        sourceId: 'chat-1',
        messageId: 2,
        date: '2026-07-09T07:00:00.000Z',
        senderName: 'Mira',
        text: 'Need to check Telegram sync before deploy?'
      }
    ]
  });
}

test('listSources returns enabled sources by default', async () => {
  const service = createFixtureService();
  const result = await service.listSources();

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].sourceId, 'chat-1');
});

test('listSources can find sources by title query', async () => {
  const service = createFixtureService();
  const result = await service.listSources({ sourceQuery: 'project' });

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].title, 'Project Chat');
});

test('getDailyDigest summarizes selected Telegram messages', async () => {
  const service = createFixtureService();
  const result = await service.getDailyDigest({
    date: '2026-07-09',
    timezone: 'UTC'
  });

  assert.equal(result.messageCount, 2);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.questions.length, 1);
  assert.equal(result.actionItems.length, 1);
  assert.equal(result.links[0].url, 'https://example.com/spec');
  assert.equal(result.sourceDigests.length, 1);
  assert.equal(result.sourceDigests[0].sourceId, 'chat-1');
  assert.equal(result.timeline.length, 2);
  assert.equal(result.timelineTruncated, false);
});

test('getDailyDigest supports compact timeline limits', async () => {
  const service = createFixtureService();
  const result = await service.getDailyDigest({
    date: '2026-07-09',
    timezone: 'UTC',
    timelineLimit: 1
  });

  assert.equal(result.timeline.length, 1);
  assert.equal(result.timelineTruncated, true);
});

test('getDailyDigest can omit timeline excerpts', async () => {
  const service = createFixtureService();
  const result = await service.getDailyDigest({
    date: '2026-07-09',
    timezone: 'UTC',
    includeTimeline: false
  });

  assert.deepEqual(result.timeline, []);
  assert.equal(result.timelineTruncated, false);
});

test('getDailyDigest can filter by source query', async () => {
  const service = createFixtureService();
  const result = await service.getDailyDigest({
    date: '2026-07-09',
    timezone: 'UTC',
    sourceQuery: 'project'
  });

  assert.equal(result.messageCount, 2);
  assert.deepEqual(result.sourceIds, ['chat-1']);
});

test('getDailyDigest reuses cached digest until refresh is requested', async () => {
  const store = createFixtureStore();
  const service = createTelegramDigestService(store);
  const originalFindMessages = store.findMessages.bind(store);
  let findMessagesCount = 0;
  store.findMessages = async (args) => {
    findMessagesCount += 1;
    return originalFindMessages(args);
  };

  const first = await service.getDailyDigest({
    date: '2026-07-09',
    timezone: 'UTC'
  });
  const second = await service.getDailyDigest({
    date: '2026-07-09',
    timezone: 'UTC'
  });
  const refreshed = await service.getDailyDigest({
    date: '2026-07-09',
    timezone: 'UTC',
    refresh: true
  });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(refreshed.cached, false);
  assert.equal(first.cacheKey, second.cacheKey);
  assert.equal(first.cacheKey, refreshed.cacheKey);
  assert.equal(findMessagesCount, 2);
  assert.equal(store.savedDigests.length, 1);
});

test('getDailyDigest invalidates cache when source sync state changes', async () => {
  const store = createFixtureStore();
  const service = createTelegramDigestService(store);
  const originalFindMessages = store.findMessages.bind(store);
  let findMessagesCount = 0;
  store.findMessages = async (args) => {
    findMessagesCount += 1;
    return originalFindMessages(args);
  };

  const first = await service.getDailyDigest({
    date: '2026-07-09',
    timezone: 'UTC'
  });
  await store.markSourceSynced('chat-1', {
    lastSyncedMessageId: 2,
    messageCount: 1
  });
  const second = await service.getDailyDigest({
    date: '2026-07-09',
    timezone: 'UTC'
  });

  assert.equal(second.cached, false);
  assert.notEqual(first.cacheKey, second.cacheKey);
  assert.equal(findMessagesCount, 2);
});

test('getSourceSummary summarizes a selected source', async () => {
  const service = createFixtureService();
  const result = await service.getSourceSummary({
    sourceId: 'chat-1',
    date: '2026-07-09',
    timezone: 'UTC',
    timelineLimit: 1
  });

  assert.equal(result.found, true);
  assert.equal(result.source.sourceId, 'chat-1');
  assert.equal(result.messageCount, 2);
  assert.equal(result.timeline.length, 1);
});

test('getSourceSummary reports disabled sources without summarizing them', async () => {
  const service = createFixtureService();
  const result = await service.getSourceSummary({
    sourceId: 'chat-2',
    date: '2026-07-09',
    timezone: 'UTC'
  });

  assert.equal(result.found, false);
  assert.equal(result.source.sourceId, 'chat-2');
  assert.equal(result.messageCount, 0);
});

test('searchMessages searches only enabled sources', async () => {
  const service = createFixtureService();
  const result = await service.searchMessages({ query: 'disabled', limit: 10 });

  assert.equal(result.count, 0);
});

test('searchMessages can filter by source query', async () => {
  const service = createFixtureService();
  const result = await service.searchMessages({
    query: 'deploy',
    sourceQuery: 'project',
    limit: 10
  });

  assert.equal(result.count, 1);
  assert.equal(result.results[0].sourceId, 'chat-1');
});

test('getMessageContext returns surrounding messages', async () => {
  const service = createFixtureService();
  const result = await service.getMessageContext({
    sourceId: 'chat-1',
    messageId: 2,
    before: 1,
    after: 1
  });

  assert.equal(result.found, true);
  assert.equal(result.before.length, 1);
  assert.equal(result.before[0].messageId, 1);
});
