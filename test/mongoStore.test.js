import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoTelegramStore } from '../src/storage/mongoStore.js';

function createStoreHarness() {
  const operations = [];
  const collection = {
    updateOne: async (...args) => {
      operations.push(args);
      return {};
    }
  };
  const db = {
    databaseName: 'test',
    collection: () => collection
  };
  const client = {
    close: async () => {}
  };

  return {
    store: new MongoTelegramStore(db, client),
    operations
  };
}

test('upsertSource does not set enabled in both $set and $setOnInsert', async () => {
  const { store, operations } = createStoreHarness();

  await store.upsertSource({
    sourceId: 'chat-1',
    title: 'Project Chat',
    type: 'Chat',
    enabled: true,
    tags: ['work']
  });

  const [, update] = operations[0];

  assert.equal(update.$set.enabled, true);
  assert.equal(Object.hasOwn(update.$setOnInsert, 'enabled'), false);
  assert.equal(Object.hasOwn(update.$set, 'tags'), false);
  assert.deepEqual(update.$setOnInsert.tags, ['work']);
});

test('upsertSource preserves existing enabled while defaulting it on insert', async () => {
  const { store, operations } = createStoreHarness();

  await store.upsertSource({
    sourceId: 'chat-1',
    title: 'Project Chat',
    type: 'Chat',
    enabled: true,
    tags: ['work']
  }, {
    preserveEnabled: true,
    preserveTags: false
  });

  const [, update] = operations[0];

  assert.equal(Object.hasOwn(update.$set, 'enabled'), false);
  assert.equal(update.$setOnInsert.enabled, true);
  assert.deepEqual(update.$set.tags, ['work']);
  assert.equal(Object.hasOwn(update.$setOnInsert, 'tags'), false);
});
