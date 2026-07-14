import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryTelegramStore } from '../src/storage/memoryStore.js';
import {
  createTelegramLoginReport,
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

test('createTelegramLoginReport reports authorization state', async () => {
  const okReport = await createTelegramLoginReport({
    client: {
      checkAuthorization: async () => true
    },
    config: {
      telegramSessionFile: '/srv/tg-mcp/shared/sessions/telegram.session'
    }
  });
  const errorReport = await createTelegramLoginReport({
    client: {
      checkAuthorization: async () => false
    },
    config: {
      telegramSessionFile: '/srv/tg-mcp/shared/sessions/telegram.session'
    }
  });

  assert.deepEqual(okReport, {
    status: 'ok',
    authorized: true,
    sessionFile: '/srv/tg-mcp/shared/sessions/telegram.session'
  });
  assert.deepEqual(errorReport, {
    status: 'error',
    authorized: false,
    sessionFile: '/srv/tg-mcp/shared/sessions/telegram.session'
  });
});

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

test('normalizeTelegramMessage maps Telegram voice metadata into transcription queue fields', () => {
  const source = normalizeTelegramSource(dialogs[0], { allowedSourceIds: ['1001'] });
  const message = normalizeTelegramMessage(
    {
      id: 43,
      date: 1783620000,
      message: '',
      voice: {
        id: { toString: () => '555' },
        accessHash: { toString: () => '777' },
        mimeType: 'audio/ogg',
        size: 123456,
        dcId: 2,
        attributes: [
          { className: 'DocumentAttributeAudio', duration: 900 },
          { className: 'DocumentAttributeFilename', fileName: 'conversation.ogg' }
        ]
      }
    },
    source
  );

  assert.equal(message.text, '');
  assert.equal(message.media.kind, 'voice');
  assert.equal(message.media.mimeType, 'audio/ogg');
  assert.equal(message.media.durationSec, 900);
  assert.equal(message.media.fileName, 'conversation.ogg');
  assert.equal(message.media.documentId, '555');
  assert.deepEqual(message.transcription, {
    status: 'pending',
    attempts: 0
  });
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
  const store = new MemoryTelegramStore({
    sources: [{
      sourceId: '1001',
      title: 'Allowed Channel',
      username: 'allowed_channel',
      type: 'Channel',
      enabled: true,
      tags: []
    }]
  });

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
  assert.equal(result.audioMessageCount, 0);
  assert.deepEqual(result.sources, [
    {
      sourceId: '1001',
      title: 'Allowed Channel',
      messageCount: 1,
      audioMessageCount: 0,
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

test('syncTelegramMessages stores audio-only messages for later transcription', async () => {
  const client = new FakeTelegramClient({
    dialogs,
    messagesBySource: {
      1001: [
        {
          id: 10,
          date: 1783620000,
          message: '',
          audio: {
            id: { toString: () => 'audio-doc' },
            mimeType: 'audio/mpeg',
            size: 3000,
            attributes: [
              { className: 'DocumentAttributeAudio', duration: 120, title: 'Planning call' }
            ]
          }
        }
      ]
    }
  });
  const store = new MemoryTelegramStore({
    sources: [{
      sourceId: '1001',
      title: 'Allowed Channel',
      username: 'allowed_channel',
      type: 'Channel',
      enabled: true,
      tags: []
    }]
  });

  const result = await syncTelegramMessages({
    client,
    store,
    config: {
      allowedSourceIds: ['1001'],
      telegramSyncLimit: 50
    }
  });

  assert.equal(result.messageCount, 1);
  assert.equal(result.audioMessageCount, 1);
  assert.equal(result.sources[0].audioMessageCount, 1);
  const messages = await store.findMessages({ sourceIds: ['1001'] });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].media.kind, 'audio');
  assert.equal(messages[0].transcription.status, 'pending');
});

test('refreshTelegramSources preserves existing DB selection and tags', async () => {
  const client = new FakeTelegramClient({ dialogs, messagesBySource: {} });
  const store = new MemoryTelegramStore({
    sources: [
      {
        sourceId: '1001',
        title: 'Old title',
        enabled: true,
        tags: ['team'],
        settings: { priority: 90, historyDepthDays: 14 }
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
  assert.deepEqual(source.settings, { priority: 90, historyDepthDays: 14 });
  assert.equal(result.selectedSourceCount, 1);
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

test('syncTelegramMessages cannot sync a disabled source by explicit id', async () => {
  const client = new FakeTelegramClient({ dialogs, messagesBySource: {} });
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: '1001', title: 'Allowed Channel', enabled: false, tags: [] }]
  });

  await assert.rejects(
    syncTelegramMessages({
      client,
      store,
      config: { allowedSourceIds: [], telegramSyncLimit: 10 },
      sourceIds: ['1001']
    }),
    /No enabled Telegram sources/
  );
  assert.equal(client.iterCalls.length, 0);
});

test('syncTelegramMessages enforces ALLOWED_SOURCE_IDS as a hard ceiling', async () => {
  const client = new FakeTelegramClient({ dialogs, messagesBySource: {} });
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: '2002', title: 'Other Chat', enabled: true, tags: [] }]
  });

  await assert.rejects(
    syncTelegramMessages({
      client,
      store,
      config: { allowedSourceIds: ['1001'], telegramSyncLimit: 10 },
      sourceIds: ['2002']
    }),
    /No enabled Telegram sources/
  );
  assert.equal(client.iterCalls.length, 0);
});

test('syncTelegramMessages applies reply, forwarded, and media settings before storage', async () => {
  const client = new FakeTelegramClient({
    dialogs,
    messagesBySource: {
      1001: [
        { id: 1, date: 1784020000, message: 'Plain update' },
        { id: 2, date: 1784020000, message: 'Reply', replyTo: { replyToMsgId: 1 } },
        { id: 3, date: 1784020000, message: 'Forward', fwdFrom: { fromId: 99 } },
        {
          id: 4,
          date: 1784020000,
          message: '',
          voice: {
            id: 100,
            mimeType: 'audio/ogg',
            attributes: [{ className: 'DocumentAttributeAudio', duration: 10 }]
          }
        },
        {
          id: 5,
          date: 1784020000,
          message: 'Audio caption',
          voice: {
            id: 101,
            mimeType: 'audio/ogg',
            attributes: [{ className: 'DocumentAttributeAudio', duration: 10 }]
          }
        }
      ]
    }
  });
  const store = new MemoryTelegramStore({
    sources: [{
      sourceId: '1001',
      title: 'Allowed Channel',
      enabled: true,
      tags: [],
      settings: {
        includeMedia: false,
        includeReplies: false,
        includeForwardedPosts: false,
        historyDepthDays: 30
      }
    }]
  });

  const result = await syncTelegramMessages({
    client,
    store,
    config: { allowedSourceIds: [], telegramSyncLimit: 10 },
    now: new Date('2026-07-14T12:00:00.000Z')
  });

  assert.equal(result.messageCount, 2);
  assert.equal(result.audioMessageCount, 0);
  const messages = await store.findMessages({ sourceIds: ['1001'], sort: 'asc' });
  assert.deepEqual(messages.map((message) => message.messageId), [1, 5]);
  assert.equal(messages[1].media, undefined);
  assert.equal(messages[1].transcription, undefined);
});
