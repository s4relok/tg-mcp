import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createImageCache } from '../src/images/imageCache.js';
import { createTelegramImageService } from '../src/images/imageService.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function imageMessage(messageId, date, overrides = {}) {
  return {
    sourceId: 'work',
    sourceTitle: 'Work Chat',
    messageId,
    date,
    senderName: 'Andrei',
    text: `image ${messageId}`,
    transcriptText: '',
    media: {
      kind: 'photo',
      mimeType: 'image/jpeg',
      size: 1000 + messageId,
      width: 1280,
      height: 720
    },
    raw: {
      groupedId: overrides.groupedId || null
    },
    ...overrides
  };
}

test('listSourceImages returns a bounded exact-source catalog and pagination cursor', async () => {
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'work', title: 'Work Chat', enabled: true },
      { sourceId: 'other', title: 'Other Chat', enabled: true }
    ],
    messages: [
      imageMessage(3, '2026-07-25T12:00:00.000Z', { groupedId: 'album-1' }),
      imageMessage(2, '2026-07-25T11:00:00.000Z'),
      imageMessage(1, '2026-07-25T10:00:00.000Z'),
      {
        ...imageMessage(9, '2026-07-25T13:00:00.000Z'),
        sourceId: 'other'
      },
      {
        sourceId: 'work',
        messageId: 4,
        date: '2026-07-25T13:00:00.000Z',
        text: 'plain text'
      }
    ]
  });
  const service = createTelegramImageService({
    config: { allowedSourceIds: [], mcpImageListMaxLimit: 100 },
    store
  });

  const first = await service.listSourceImages({
    sourceId: 'work',
    limit: 2
  });
  const second = await service.listSourceImages({
    sourceId: 'work',
    beforeMessageId: first.nextBeforeMessageId,
    limit: 2
  });

  assert.deepEqual(first.images.map((image) => image.messageId), [3, 2]);
  assert.equal(first.images[0].groupedId, 'album-1');
  assert.equal(first.nextBeforeMessageId, 2);
  assert.deepEqual(second.images.map((image) => image.messageId), [1]);
  assert.equal(second.nextBeforeMessageId, null);
});

test('listSourceImages rejects inaccessible sources and hints when the catalog is empty', async () => {
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'work', title: 'Work Chat', enabled: true },
      { sourceId: 'disabled', title: 'Disabled Chat', enabled: false }
    ]
  });
  const service = createTelegramImageService({
    config: {
      allowedSourceIds: ['work'],
      mcpImageListMaxLimit: 100
    },
    store
  });

  const empty = await service.listSourceImages({ sourceId: 'work' });
  const disabled = await service.listSourceImages({ sourceId: 'disabled' });

  assert.equal(empty.status, 'ok');
  assert.match(empty.hint, /sync_source/);
  assert.equal(disabled.status, 'rejected');
  assert.equal(disabled.reason, 'disabled');
});

test('getTelegramImages serves cache hits without Telegram and caches misses for 30 days', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-image-service-'));
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'work', title: 'Work Chat', enabled: true }],
    messages: [
      imageMessage(1, '2026-07-25T10:00:00.000Z'),
      imageMessage(2, '2026-07-25T11:00:00.000Z')
    ]
  });
  const config = {
    allowedSourceIds: [],
    mcpImageListMaxLimit: 100,
    mcpImageGetMaxItems: 5,
    mcpImageMaxFileBytes: 1024 * 1024,
    mcpImageMaxTotalBytes: 2 * 1024 * 1024,
    imageCacheDir: root,
    imageCacheRetentionDays: 30
  };
  const cache = createImageCache({
    config,
    store,
    now: () => new Date('2026-07-25T12:00:00.000Z')
  });
  await cache.storeBuffer({
    sourceId: 'work',
    messageId: 1,
    mimeType: 'image/jpeg',
    buffer: Buffer.from('cached-image')
  });
  let clients = 0;
  let disconnected = false;
  const service = createTelegramImageService({
    config,
    store,
    cache,
    createClient: async () => {
      clients += 1;
      return {
        disconnect: async () => {
          disconnected = true;
        }
      };
    },
    getMessage: async ({ messageId }) => ({ id: messageId }),
    downloadImage: async ({ metadata }) => ({
      buffer: Buffer.from(`downloaded-${metadata.messageId}`),
      mimeType: 'image/jpeg'
    })
  });

  const result = await service.getTelegramImages({
    sourceId: 'work',
    messageIds: [1, 2, 999]
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.items[0].cacheHit, true);
  assert.equal(result.items[1].cacheHit, false);
  assert.equal(Buffer.from(result.items[0].data, 'base64').toString(), 'cached-image');
  assert.equal(Buffer.from(result.items[1].data, 'base64').toString(), 'downloaded-2');
  assert.equal(result.items[2].status, 'error');
  assert.equal(clients, 1);
  assert.equal(disconnected, true);

  const stored = await cache.getValidEntry('work', 2);
  assert.equal(stored.entry.expiresAt.toISOString(), '2026-08-24T12:00:00.000Z');
});

test('cacheSourceImages is bounded and skips unexpired cache entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-image-sync-cache-'));
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'work', title: 'Work Chat', enabled: true }],
    messages: [
      imageMessage(3, '2026-07-25T12:00:00.000Z'),
      imageMessage(2, '2026-07-25T11:00:00.000Z'),
      imageMessage(1, '2026-07-25T10:00:00.000Z')
    ]
  });
  const config = {
    allowedSourceIds: [],
    mcpImageCacheMaxItemsPerSync: 2,
    mcpImageMaxFileBytes: 1024 * 1024,
    imageCacheDir: root,
    imageCacheRetentionDays: 30
  };
  const cache = createImageCache({
    config,
    store,
    now: () => new Date('2026-07-25T12:00:00.000Z')
  });
  await cache.storeBuffer({
    sourceId: 'work',
    messageId: 3,
    mimeType: 'image/jpeg',
    buffer: Buffer.from('already-cached')
  });
  const downloadedIds = [];
  const service = createTelegramImageService({
    config,
    store,
    cache,
    getMessage: async ({ messageId }) => ({ id: messageId }),
    downloadImage: async ({ metadata }) => {
      downloadedIds.push(metadata.messageId);
      return {
        buffer: Buffer.from(`image-${metadata.messageId}`),
        mimeType: 'image/jpeg'
      };
    }
  });

  const result = await service.cacheSourceImages({
    sourceId: 'work',
    client: {},
    limit: 2
  });

  assert.equal(result.requested, 2);
  assert.equal(result.alreadyCached, 1);
  assert.equal(result.cached, 1);
  assert.deepEqual(downloadedIds, [2]);
  assert.equal((await store.listAllMediaCacheEntries()).length, 2);
});

test('getTelegramImages enforces the total response size while keeping successful items', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-image-total-'));
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'work', title: 'Work Chat', enabled: true }],
    messages: [
      imageMessage(1, '2026-07-25T10:00:00.000Z'),
      imageMessage(2, '2026-07-25T11:00:00.000Z')
    ]
  });
  const config = {
    allowedSourceIds: [],
    mcpImageGetMaxItems: 5,
    mcpImageMaxFileBytes: 100,
    mcpImageMaxTotalBytes: 10,
    imageCacheDir: root,
    imageCacheRetentionDays: 30
  };
  const cache = createImageCache({ config, store });
  await cache.storeBuffer({
    sourceId: 'work',
    messageId: 1,
    mimeType: 'image/jpeg',
    buffer: Buffer.from('123456')
  });
  await cache.storeBuffer({
    sourceId: 'work',
    messageId: 2,
    mimeType: 'image/jpeg',
    buffer: Buffer.from('abcdef')
  });
  const service = createTelegramImageService({ config, store, cache });

  const result = await service.getTelegramImages({
    sourceId: 'work',
    messageIds: [1, 2]
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.items[0].status, 'ok');
  assert.equal(result.items[1].status, 'error');
  assert.match(result.items[1].error, /response limit/);
  assert.equal(result.totalBytes, 6);
});

test('getTelegramImages rejects disabled and outside-ceiling sources before Telegram access', async () => {
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'disabled', title: 'Disabled', enabled: false },
      { sourceId: 'outside', title: 'Outside', enabled: true }
    ]
  });
  let clients = 0;
  const service = createTelegramImageService({
    config: {
      allowedSourceIds: ['allowed'],
      mcpImageGetMaxItems: 5
    },
    store,
    createClient: async () => {
      clients += 1;
      return {};
    }
  });

  const disabled = await service.getTelegramImages({
    sourceId: 'disabled',
    messageIds: [1]
  });
  const outside = await service.getTelegramImages({
    sourceId: 'outside',
    messageIds: [1]
  });

  assert.equal(disabled.reason, 'disabled');
  assert.equal(outside.reason, 'outside_allowed_source_ids');
  assert.equal(clients, 0);
});
