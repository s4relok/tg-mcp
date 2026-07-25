import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createImageCache } from '../src/images/imageCache.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function cacheConfig(root) {
  return {
    imageCacheDir: root,
    imageCacheRetentionDays: 30,
    mcpImageMaxFileBytes: 1024 * 1024
  };
}

test('image cache stores private files for a fixed 30 days without sliding expiry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-image-cache-'));
  const store = new MemoryTelegramStore();
  let current = new Date('2026-07-25T10:00:00.000Z');
  const cache = createImageCache({
    config: cacheConfig(root),
    store,
    now: () => new Date(current)
  });
  const buffer = Buffer.from('jpeg-image-bytes');

  const entry = await cache.storeBuffer({
    sourceId: 'work',
    messageId: 1,
    mimeType: 'image/jpeg',
    buffer
  });
  assert.equal(entry.cachedAt.toISOString(), '2026-07-25T10:00:00.000Z');
  assert.equal(entry.expiresAt.toISOString(), '2026-08-24T10:00:00.000Z');
  const stat = await fs.stat(path.join(root, entry.relativePath));
  assert.equal(stat.size, buffer.length);

  current = new Date('2026-08-10T10:00:00.000Z');
  const hit = await cache.getValidEntry('work', 1);
  assert.deepEqual(hit.buffer, buffer);
  assert.equal(hit.entry.expiresAt.toISOString(), entry.expiresAt.toISOString());

  current = new Date('2026-08-24T10:00:00.000Z');
  const expired = await cache.getValidEntry('work', 1);
  assert.equal(expired, null);
  await assert.rejects(() => fs.stat(path.join(root, entry.relativePath)), /ENOENT/);
  assert.deepEqual(await store.listAllMediaCacheEntries(), []);
});

test('image cache cleanup deletes expired records and orphan files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-image-cleanup-'));
  const store = new MemoryTelegramStore();
  let current = new Date('2026-07-25T10:00:00.000Z');
  const cache = createImageCache({
    config: cacheConfig(root),
    store,
    now: () => new Date(current)
  });
  await cache.storeBuffer({
    sourceId: 'work',
    messageId: 1,
    mimeType: 'image/png',
    buffer: Buffer.from('png-image-bytes')
  });
  const orphan = path.join(root, 'orphan.jpg');
  await fs.writeFile(orphan, 'orphan');
  current = new Date('2026-08-25T10:00:00.000Z');

  const result = await cache.cleanup();

  assert.equal(result.expiredCount, 1);
  assert.equal(result.orphanCount, 1);
  await assert.rejects(() => fs.stat(orphan), /ENOENT/);
  assert.deepEqual(await store.listAllMediaCacheEntries(), []);
});

test('image cache rejects unsafe paths without touching files outside the cache root', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-image-safe-'));
  const root = path.join(parent, 'cache');
  const outside = path.join(parent, 'outside.jpg');
  await fs.writeFile(outside, 'outside');
  const store = new MemoryTelegramStore({
    mediaCache: [{
      sourceId: 'work',
      messageId: 1,
      relativePath: '../outside.jpg',
      mimeType: 'image/jpeg',
      size: 7,
      sha256: 'invalid',
      cachedAt: '2026-07-25T10:00:00.000Z',
      expiresAt: '2026-08-24T10:00:00.000Z'
    }]
  });
  const cache = createImageCache({
    config: cacheConfig(root),
    store,
    now: () => new Date('2026-07-26T10:00:00.000Z')
  });

  assert.equal(await cache.getValidEntry('work', 1), null);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  assert.deepEqual(await store.listAllMediaCacheEntries(), []);
});
