import assert from 'node:assert/strict';
import test from 'node:test';

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
