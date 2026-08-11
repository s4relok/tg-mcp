import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryTelegramStore } from '../src/storage/memoryStore.js';
import {
  createTelegramReactionWorker,
  handleTelegramReactionUpdate
} from '../src/telegram/reactionWorker.js';

function fixtureStore() {
  return new MemoryTelegramStore({
    sources: [{ sourceId: '1001', title: 'Project', enabled: true }],
    messages: [{
      sourceId: '1001',
      messageId: 42,
      date: '2026-08-11T12:00:00.000Z',
      text: 'React to this',
      reactions: [],
      reactionCount: 0
    }]
  });
}

test('handleTelegramReactionUpdate updates reactions on an existing message', async () => {
  const store = fixtureStore();
  const result = await handleTelegramReactionUpdate({
    store,
    update: {
      className: 'UpdateMessageReactions',
      peer: { channelId: { toString: () => '1001' } },
      msgId: 42,
      reactions: {
        results: [
          { reaction: { className: 'ReactionEmoji', emoticon: '❤️' }, count: 4 }
        ]
      }
    }
  });

  assert.equal(result.handled, true);
  assert.deepEqual(store.messages[0].reactions, [
    { type: 'emoji', emoji: '❤️', count: 4, chosen: false }
  ]);
  assert.equal(store.messages[0].reactionCount, 4);
  assert.ok(store.sources[0].updatedAt instanceof Date);
});

test('handleTelegramReactionUpdate clears reactions and ignores unknown messages', async () => {
  const store = fixtureStore();
  store.messages[0].reactions = [{ type: 'emoji', emoji: '👍', count: 1, chosen: false }];
  store.messages[0].reactionCount = 1;

  const cleared = await handleTelegramReactionUpdate({
    store,
    update: {
      className: 'UpdateMessageReactions',
      peer: { channelId: 1001 },
      msgId: 42,
      reactions: { results: [] }
    }
  });
  const missing = await handleTelegramReactionUpdate({
    store,
    update: {
      className: 'UpdateMessageReactions',
      peer: { channelId: 1001 },
      msgId: 999,
      reactions: { results: [] }
    }
  });

  assert.equal(cleared.handled, true);
  assert.deepEqual(store.messages[0].reactions, []);
  assert.equal(store.messages[0].reactionCount, 0);
  assert.deepEqual(missing, {
    handled: false,
    reason: 'message_not_stored',
    sourceId: '1001',
    messageId: 999,
    reactions: []
  });
});

test('handleTelegramReactionUpdate ignores disabled and outside-ceiling sources', async () => {
  const store = fixtureStore();
  store.sources[0].enabled = false;
  const update = {
    className: 'UpdateMessageReactions',
    peer: { channelId: 1001 },
    msgId: 42,
    reactions: { results: [] }
  };

  assert.deepEqual(await handleTelegramReactionUpdate({ update, store }), {
    handled: false,
    reason: 'source_not_enabled',
    sourceId: '1001'
  });
  store.sources[0].enabled = true;
  assert.deepEqual(await handleTelegramReactionUpdate({
    update,
    store,
    allowedSourceIds: ['2002']
  }), {
    handled: false,
    reason: 'outside_allowed_source_ids',
    sourceId: '1001'
  });
});

test('reaction worker keeps a Telegram client connected and processes raw updates', async () => {
  const store = fixtureStore();
  let handler;
  let disconnectCount = 0;
  const worker = createTelegramReactionWorker({
    config: { telegramSyncEnabled: true },
    store,
    logger: { info() {}, warn() {} },
    createClient: async () => ({
      addEventHandler(callback) {
        handler = callback;
      },
      async disconnect() {
        disconnectCount += 1;
      }
    })
  });

  assert.deepEqual(worker.start(), { started: true });
  assert.deepEqual(await worker.ready(), { started: true });
  await handler({
    className: 'UpdateMessageReactions',
    peer: { channelId: 1001 },
    msgId: 42,
    reactions: {
      results: [{ reaction: { className: 'ReactionEmoji', emoticon: '🔥' }, count: 7 }]
    }
  });
  await worker.stop();

  assert.equal(store.messages[0].reactionCount, 7);
  assert.equal(disconnectCount, 1);
});
