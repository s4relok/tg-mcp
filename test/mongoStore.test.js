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

function createBulkStoreHarness() {
  const bulkOperations = [];
  const collection = {
    bulkWrite: async (operations) => {
      bulkOperations.push(...operations);
      return {
        upsertedCount: 1,
        modifiedCount: 0,
        matchedCount: 0
      };
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
    bulkOperations
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

test('upsertMessages only initializes transcription fields on insert', async () => {
  const { store, bulkOperations } = createBulkStoreHarness();

  await store.upsertMessages([
    {
      sourceId: 'saved',
      messageId: 1,
      date: new Date('2026-07-09T09:00:00.000Z'),
      text: '',
      transcriptText: '',
      media: { kind: 'voice', mimeType: 'audio/ogg' },
      transcription: { status: 'pending', attempts: 0 }
    }
  ]);

  const update = bulkOperations[0].updateOne.update;
  assert.equal(Object.hasOwn(update.$set, 'transcriptText'), false);
  assert.equal(Object.hasOwn(update.$set, 'transcription'), false);
  assert.equal(update.$setOnInsert.transcriptText, '');
  assert.deepEqual(update.$setOnInsert.transcription, { status: 'pending', attempts: 0 });
});
