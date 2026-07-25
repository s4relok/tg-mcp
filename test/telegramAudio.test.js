import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getTelegramMessageById,
  resolveTelegramSourceEntity
} from '../src/audio/telegramAudio.js';

test('resolveTelegramSourceEntity matches the exact dialog id instead of treating a channel as a user', async () => {
  const channel = {
    id: { toString: () => '1733118383' },
    className: 'Channel',
    accessHash: { toString: () => '12345' }
  };
  const user = {
    id: { toString: () => '999' },
    className: 'User'
  };
  let dialogReads = 0;
  const client = {
    getDialogs: async () => {
      dialogReads += 1;
      return [{ entity: user }, { entity: channel }];
    }
  };

  const first = await resolveTelegramSourceEntity({
    client,
    sourceId: '1733118383'
  });
  const second = await resolveTelegramSourceEntity({
    client,
    sourceId: '1733118383'
  });

  assert.equal(first, channel);
  assert.equal(second, channel);
  assert.equal(dialogReads, 1);
});

test('getTelegramMessageById passes the resolved channel entity to Telegram', async () => {
  const channel = {
    id: { toString: () => '1733118383' },
    className: 'Channel',
    accessHash: { toString: () => '12345' }
  };
  const message = { id: 727 };
  let requestedEntity = null;
  let requestedIds = null;
  const client = {
    getDialogs: async () => [{ entity: channel }],
    getMessages: async (entity, options) => {
      requestedEntity = entity;
      requestedIds = options.ids;
      return [message];
    }
  };

  const result = await getTelegramMessageById({
    client,
    sourceId: '1733118383',
    messageId: 727
  });

  assert.equal(result, message);
  assert.equal(requestedEntity, channel);
  assert.equal(requestedIds, 727);
});

test('resolveTelegramSourceEntity rejects ids outside authorized dialogs', async () => {
  const client = {
    getDialogs: async () => [{
      entity: {
        id: { toString: () => '1' },
        className: 'User'
      }
    }]
  };

  await assert.rejects(
    resolveTelegramSourceEntity({ client, sourceId: '2' }),
    /Telegram source was not found in authorized dialogs: 2/
  );
});
