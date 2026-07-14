import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSourceManagementService,
  SourceManagementError
} from '../src/services/sourceManagement.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function createFixture() {
  const store = new MemoryTelegramStore({
    sources: [
      {
        sourceId: 'channel-1',
        title: 'Game Industry Wire',
        username: 'gameindustrywire',
        type: 'Channel',
        enabled: false,
        tags: ['news']
      },
      {
        sourceId: 'chat-1',
        title: 'Private Work Chat',
        username: null,
        type: 'Chat',
        enabled: false,
        tags: []
      }
    ]
  });
  const config = {
    sourceDefaultSyncIntervalSeconds: 300,
    sourceDefaultHistoryDepthDays: 30,
    sourceDefaultIncludeMedia: true,
    sourceDefaultIncludeReplies: true,
    sourceDefaultIncludeForwardedPosts: true,
    sourceDefaultPriority: 50,
    sourceMutationBatchLimit: 25
  };
  return {
    store,
    service: createSourceManagementService({ store, config })
  };
}

test('getSourceSettings returns stored and effective defaults', async () => {
  const { service } = createFixture();
  const result = await service.getSourceSettings('channel-1');

  assert.equal(result.status, 'ok');
  assert.equal(result.source.enabled, false);
  assert.equal(result.source.effectiveSettings.syncIntervalSeconds, 300);
  assert.equal(result.source.effectiveSettings.historyDepthDays, 30);
  assert.ok(result.source.inheritedSettings.includes('priority'));
});

test('updateSourceSettings validates versions, is idempotent, and writes audit records', async () => {
  const { store, service } = createFixture();
  const updated = await service.updateSourceSettings({
    sourceId: 'channel-1',
    settings: { syncIntervalSeconds: 900, priority: 80 },
    expectedVersion: 0,
    actor: 'test'
  });

  assert.equal(updated.status, 'updated');
  assert.equal(updated.source.settingsVersion, 1);
  assert.equal(updated.source.effectiveSettings.syncIntervalSeconds, 900);
  assert.equal(store.sourceAudit.length, 1);
  assert.equal(store.sourceAudit[0].action, 'update_settings');

  const unchanged = await service.updateSourceSettings({
    sourceId: 'channel-1',
    settings: { syncIntervalSeconds: 900 },
    expectedVersion: 1,
    actor: 'test'
  });
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(store.sourceAudit.length, 1);

  const conflict = await service.updateSourceSettings({
    sourceId: 'channel-1',
    settings: { priority: 10 },
    expectedVersion: 0,
    actor: 'test'
  });
  assert.equal(conflict.status, 'conflict');
});

test('enableSource requires explicit confirmation for private sources', async () => {
  const { service } = createFixture();
  const confirmation = await service.enableSources({
    sourceIds: ['chat-1'],
    actor: 'mcp'
  });
  assert.equal(confirmation.status, 'confirmation_required');
  assert.equal(confirmation.sources[0].sensitive, true);

  const enabled = await service.enableSources({
    sourceIds: ['chat-1'],
    confirmSensitive: true,
    tags: ['Work'],
    actor: 'mcp'
  });
  assert.equal(enabled.status, 'updated');
  assert.equal(enabled.sources[0].enabled, true);
  assert.deepEqual(enabled.sources[0].tags, ['work']);
});

test('tag modes preserve, remove, and replace tags', async () => {
  const { service } = createFixture();
  const added = await service.setSourceTags({
    sourceIds: ['channel-1'],
    tags: ['GameDev'],
    tagMode: 'add',
    actor: 'test'
  });
  assert.deepEqual(added.sources[0].tags, ['news', 'gamedev']);

  const removed = await service.setSourceTags({
    sourceIds: ['channel-1'],
    tags: ['news'],
    tagMode: 'remove',
    actor: 'test'
  });
  assert.deepEqual(removed.sources[0].tags, ['gamedev']);

  const replaced = await service.setSourceTags({
    sourceIds: ['channel-1'],
    tags: ['industry'],
    tagMode: 'replace',
    actor: 'test'
  });
  assert.deepEqual(replaced.sources[0].tags, ['industry']);
});

test('preview returns exact changes without mutating the source', async () => {
  const { service } = createFixture();
  const preview = await service.enableSources({
    sourceIds: ['channel-1'],
    tags: ['gamedev'],
    preview: true,
    actor: 'mcp'
  });
  assert.equal(preview.status, 'preview');
  assert.equal(preview.changes[0].before.enabled, false);
  assert.equal(preview.changes[0].after.enabled, true);

  const current = await service.getSourceSettings('channel-1');
  assert.equal(current.source.enabled, false);
  assert.deepEqual(current.source.tags, ['news']);
});

test('invalid settings and oversized batches fail closed', async () => {
  const { service } = createFixture();
  await assert.rejects(
    service.updateSourceSettings({
      sourceId: 'channel-1',
      settings: { syncIntervalSeconds: 5 }
    }),
    (error) => error instanceof SourceManagementError && error.code === 'invalid_settings'
  );
  await assert.rejects(
    service.disableSources({ sourceIds: Array.from({ length: 26 }, (_, index) => String(index)) }),
    (error) => error instanceof SourceManagementError && error.code === 'batch_too_large'
  );
});
