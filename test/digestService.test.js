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

test('listSources returns enabled sources by default', async () => {
  const service = createFixtureService();
  const result = await service.listSources();

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].sourceId, 'chat-1');
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
});

test('searchMessages searches only enabled sources', async () => {
  const service = createFixtureService();
  const result = await service.searchMessages({ query: 'disabled', limit: 10 });

  assert.equal(result.count, 0);
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
