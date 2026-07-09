import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryTelegramStore } from '../src/storage/memoryStore.js';
import {
  listTelegramSources,
  normalizeTelegramMessage,
  normalizeTelegramSource,
  refreshTelegramSources,
  syncTelegramMessages
} from '../src/telegram/telegramSync.js';

class FakeTelegramClient {
  constructor({ dialogs, messagesBySource }) {
    this.dialogs = dialogs;
    this.messagesBySource = messagesBySource;
    this.iterCalls = [];
  }

  async getDialogs() {
    return this.dialogs;
  }

  async *iterMessages(sourceId, options) {
    this.iterCalls.push({ sourceId, options });
    for (const message of this.messagesBySource[sourceId] || []) {
      yield message;
    }
  }
}

const dialogs = [
  {
    entity: {
      id: 1001,
      title: 'Allowed Channel',
      username: 'allowed_channel',
      className: 'Channel'
    }
  },
  {
    entity: {
      id: 2002,
      title: 'Other Chat',
      className: 'Chat'
    }
  }
];

test('normalizeTelegramSource marks only allowed sources enabled', () => {
  const source = normalizeTelegramSource(dialogs[0], { allowedSourceIds: ['1001'] });

  assert.deepEqual(source, {
    sourceId: '1001',
    title: 'Allowed Channel',
    username: 'allowed_channel',
    type: 'Channel',
    enabled: true,
    tags: []
  });
});

test('normalizeTelegramMessage maps Telegram fields into storage shape', () => {
  const source = normalizeTelegramSource(dialogs[0], { allowedSourceIds: ['1001'] });
  const message = normalizeTelegramMessage(
    {
      id: 42,
      date: 1783620000,
      senderId: { toString: () => '777' },
      message: 'Need to check this?',
      replyTo: { replyToMsgId: 41 },
      views: 123,
      groupedId: { toString: () => '999' },
      post: true
    },
    source
  );

  assert.equal(message.sourceId, '1001');
  assert.equal(message.messageId, 42);
  assert.equal(message.senderId, '777');
  assert.equal(message.replyToMessageId, 41);
  assert.equal(message.link, 'https://t.me/allowed_channel/42');
  assert.equal(message.raw.groupedId, '999');
  assert.equal(message.raw.post, true);
});

test('listTelegramSources applies allowed source ids', async () => {
  const client = new FakeTelegramClient({ dialogs, messagesBySource: {} });
  const sources = await listTelegramSources({ client, allowedSourceIds: ['1001'] });

  assert.equal(sources.length, 2);
  assert.equal(sources[0].enabled, true);
  assert.equal(sources[1].enabled, false);
});

test('syncTelegramMessages stores only whitelisted sources and honors minDate', async () => {
  const client = new FakeTelegramClient({
    dialogs,
    messagesBySource: {
      1001: [
        { id: 1, date: 1783530000, message: 'Old message' },
        { id: 2, date: 1783620000, message: 'New message' }
      ],
      2002: [
        { id: 1, date: 1783620000, message: 'Should not sync' }
      ]
    }
  });
  const store = new MemoryTelegramStore();

  const result = await syncTelegramMessages({
    client,
    store,
    config: {
      allowedSourceIds: ['1001'],
      telegramSyncLimit: 50
    },
    minDate: new Date('2026-07-09T00:00:00.000Z')
  });

  assert.equal(result.sourceCount, 1);
  assert.equal(result.messageCount, 1);
  assert.deepEqual(result.sources, [
    {
      sourceId: '1001',
      title: 'Allowed Channel',
      messageCount: 1,
      lastSyncedMessageId: 2,
      incremental: false
    }
  ]);
  assert.deepEqual(client.iterCalls, [
    {
      sourceId: '1001',
      options: { limit: 50 }
    }
  ]);

  const messages = await store.findMessages({ sourceIds: ['1001'] });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'New message');
  const [source] = await store.listSources({ includeDisabled: true, sourceIds: ['1001'] });
  assert.equal(source.lastSyncedMessageId, 2);
  assert.equal(source.lastSyncMessageCount, 1);
});

test('refreshTelegramSources preserves existing DB selection and tags', async () => {
  const client = new FakeTelegramClient({ dialogs, messagesBySource: {} });
  const store = new MemoryTelegramStore({
    sources: [
      {
        sourceId: '1001',
        title: 'Old title',
        enabled: true,
        tags: ['team']
      }
    ]
  });

  const result = await refreshTelegramSources({
    client,
    store,
    config: {
      allowedSourceIds: []
    }
  });

  assert.equal(result.sourceCount, 2);

  const [source] = await store.listSources({ includeDisabled: true, sourceIds: ['1001'] });
  assert.equal(source.title, 'Allowed Channel');
  assert.equal(source.enabled, true);
  assert.deepEqual(source.tags, ['team']);
});

test('syncTelegramMessages uses DB-enabled sources when env whitelist is empty', async () => {
  const client = new FakeTelegramClient({
    dialogs,
    messagesBySource: {
      1001: [
        { id: 7, date: 1783620000, message: 'Selected from DB' }
      ],
      2002: [
        { id: 8, date: 1783620000, message: 'Not selected' }
      ]
    }
  });
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: '1001', title: 'Allowed Channel', enabled: true, tags: [] },
      { sourceId: '2002', title: 'Other Chat', enabled: false, tags: [] }
    ]
  });

  const result = await syncTelegramMessages({
    client,
    store,
    config: {
      allowedSourceIds: [],
      telegramSyncLimit: 10
    }
  });

  assert.equal(result.sourceCount, 1);
  assert.equal(result.messageCount, 1);
  assert.deepEqual(client.iterCalls, [
    {
      sourceId: '1001',
      options: { limit: 10 }
    }
  ]);
});

test('syncTelegramMessages uses lastSyncedMessageId as minId for incremental sync', async () => {
  const client = new FakeTelegramClient({
    dialogs,
    messagesBySource: {
      1001: [
        { id: 9, date: 1783620000, message: 'Newer message' }
      ]
    }
  });
  const store = new MemoryTelegramStore({
    sources: [
      {
        sourceId: '1001',
        title: 'Allowed Channel',
        enabled: true,
        tags: [],
        lastSyncedMessageId: 8
      }
    ]
  });

  const result = await syncTelegramMessages({
    client,
    store,
    config: {
      allowedSourceIds: [],
      telegramSyncLimit: 10
    }
  });

  assert.deepEqual(client.iterCalls, [
    {
      sourceId: '1001',
      options: { limit: 10, minId: 8 }
    }
  ]);
  assert.equal(result.sources[0].incremental, true);
  assert.equal(result.sources[0].lastSyncedMessageId, 9);

  const [source] = await store.listSources({ includeDisabled: true, sourceIds: ['1001'] });
  assert.equal(source.lastSyncedMessageId, 9);
});

test('syncTelegramMessages ignores lastSyncedMessageId when backfilling by minDate', async () => {
  const client = new FakeTelegramClient({
    dialogs,
    messagesBySource: {
      1001: [
        { id: 5, date: 1783620000, message: 'Backfill candidate' }
      ]
    }
  });
  const store = new MemoryTelegramStore({
    sources: [
      {
        sourceId: '1001',
        title: 'Allowed Channel',
        enabled: true,
        tags: [],
        lastSyncedMessageId: 8
      }
    ]
  });

  await syncTelegramMessages({
    client,
    store,
    config: {
      allowedSourceIds: [],
      telegramSyncLimit: 10
    },
    minDate: new Date('2026-07-09T00:00:00.000Z')
  });

  assert.deepEqual(client.iterCalls, [
    {
      sourceId: '1001',
      options: { limit: 10 }
    }
  ]);

  const [source] = await store.listSources({ includeDisabled: true, sourceIds: ['1001'] });
  assert.equal(source.lastSyncedMessageId, 8);
});
