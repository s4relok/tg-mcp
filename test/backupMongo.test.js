import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMongoStore } from '../src/storage/mongoStore.js';
import { attachBackup } from '../src/backup/integration.js';
import { createBackupService } from '../src/backup/backupService.js';
import { restoreSnapshot } from '../src/backup/snapshots.js';
import { loadConfig } from '../src/config.js';

test('real Mongo: seed, indexed mutations, leases, purge guard, and restore after database loss', {
  skip: process.env.RUN_MONGO_BACKUP_TESTS !== '1', timeout: 180000
}, async (t) => {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  t.after(() => mongod.stop());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-mongo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = loadConfig({ MONGO_URL: mongod.getUri(), MONGO_DB: 'backup_test', BACKUP_DIR: path.join(root, 'local'), BACKUP_REPLICA_DIR: path.join(root, 'replica') });
  const store = await createMongoStore(config);
  t.after(() => store.close());
  await store.upsertSource({ sourceId: '123', title: 'selected', enabled: true });
  await store.upsertSource({ sourceId: '456', title: 'selected two', enabled: true });
  await store.upsertSource({ sourceId: '789', title: 'not selected', enabled: true });
  await store.upsertMessages([
    { sourceId: '123', messageId: 1, text: 'before', date: new Date(), media: { kind: 'voice', documentId: 'audio-1', mimeType: 'audio/ogg' } },
    { sourceId: '456', messageId: 2, text: 'second chat', date: new Date() },
    { sourceId: '789', messageId: 3, text: 'must not export', date: new Date() }
  ]);
  const backup = attachBackup({ config, store });
  await backup.enable('123'); await backup.enable('456');
  await store.upsertMessages([{ sourceId: '123', messageId: 1, text: 'after', date: new Date() }]);
  await store.completeAudioTranscription({ sourceId: '123', messageId: 1, transcriptText: 'preserved spoken words', model: 'test' });
  const context = await backup.context({ sourceId: '123', messageId: 1 });
  assert.ok(context.versions.some((r) => r.payload.text === 'before'));
  assert.ok(context.versions.some((r) => r.payload.text === 'after'));
  assert.equal((await backup.search({ sourceId: '123', query: 'spoken' })).messages.length, 1);
  await store.claimSourceSync('123', { owner: 'a', lockUntil: new Date(Date.now() + 60000) });
  assert.equal(await store.renewBackupLease('123', 'b', new Date()), false);
  await store.releaseBackupLease('123', 'b');
  assert.equal((await store.listSources({ sourceIds: ['123'] }))[0].syncLockOwner, 'a');
  await store.releaseBackupLease('123', 'a');
  await assert.rejects(store.purgeSourceData('123'), /protected/);
  await store.purgeSourceData('789');
  const snapshot = await backup.replicate('123');
  await store.db.dropDatabase();
  await fs.rm(config.backupDir, { recursive: true });
  const target = path.join(root, 'restored');
  await restoreSnapshot('123', snapshot.snapshot, target);
  const restored = createBackupService({ config: { ...config, backupDir: target } });
  assert.equal((await restored.search({ sourceId: '123', query: 'spoken' })).messages.length, 1);
  assert.deepEqual((await restored.selected()).map((s) => s.sourceId), ['123']);
  assert.equal((await restored.search({ sourceId: '123', query: 'second chat' })).messages.length, 0);
});
