import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore, hash } from '../src/backup/archiveStore.js';
import { exportSnapshot, restoreSnapshot, verifySnapshot } from '../src/backup/snapshots.js';
import { attachBackup } from '../src/backup/integration.js';
import { createBackupService } from '../src/backup/backupService.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';
import { loadConfig } from '../src/config.js';
import { archiveMedia, downloadArchiveMedia, mediaKey } from '../src/backup/telegramBackup.js';
import { createImageCache } from '../src/images/imageCache.js';
import { runDailyBackup, indexFingerprint } from '../src/backup/dailyBackup.js';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = loadConfig({ BACKUP_DIR: path.join(root, 'local'), BACKUP_REPLICA_DIR: path.join(root, 'replica'),
    BACKUP_PAGE_SIZE: '2', BACKUP_MEDIA_BATCH_SIZE: '20', ALLOWED_SOURCE_IDS: '123,456' });
  const store = new MemoryTelegramStore({ sources: [
    { sourceId: '123', title: 'Protected', settings: { historyDepthDays: 1, includeMedia: false, includeReplies: false } },
    { sourceId: '456', title: 'Unprotected' }
  ], messages: options.indexed || [] });
  let remote = options.remote || [];
  let online = true;
  const calls = [];
  const client = {
    connected: true,
    async getDialogs() { if (!online) throw new Error('Telegram offline'); return [{ entity: { id: '123', title: 'Protected' } }]; },
    async getMessages(entity, args) {
      assert.equal(entity.id, '123'); calls.push(args);
      if (!online) throw new Error('Telegram offline');
      if (args.ids) return args.ids.map((id) => remote.find((m) => m.id === id)).filter(Boolean);
      return remote.slice().sort((a, b) => b.id - a.id).slice(0, args.limit);
    },
    async *iterMessages(entity, args) {
      assert.equal(entity.id, '123'); calls.push(args);
      if (!online) throw new Error('Telegram offline');
      const messages = remote.filter((m) => (!args.minId || m.id > args.minId) && (!args.offsetId || m.id < args.offsetId))
        .sort((a, b) => args.reverse ? a.id - b.id : b.id - a.id).slice(0, args.limit);
      for (const message of messages) yield message;
    },
    async downloadMedia(message, args) { await args.outputFile.write(message.bytes || Buffer.from('original')); },
    async disconnect() {}
  };
  const backup = attachBackup({ config, store, createClient: async () => client,
    createTranscriber: () => ({ transcribe: async (file) => { assert.equal(path.extname(file), '.ogg'); return { text: 'offline transcript', model: 'test' }; } }) });
  return { root, config, store, backup, client, calls, setRemote: (value) => { remote = value; }, offline: () => { online = false; } };
}

const textMessage = (id, text = `message ${id}`) => ({ id, date: 1600000000 + id, message: text, peerId: { channelId: '123' } });
const voice = (id, bytes = Buffer.from('original audio')) => {
  const document = { id: `audio-${id}`, mimeType: 'audio/ogg', size: bytes.length, attributes: [{ className: 'DocumentAttributeAudio', duration: 2 }] };
  return { ...textMessage(id, ''), voice: document, document, bytes };
};

test('chat-photo service messages archive their original photo directly', async (t) => {
  const { backup, client } = await fixture(t);
  const bytes = Buffer.from('original chat photo');
  const photo = { id: '321', sizes: [{ type: 'c', w: 640, h: 640, size: bytes.length }] };
  const message = { ...textMessage(1), className: 'MessageService', photo, action: { photo },
    async downloadMedia() { throw new Error('Service-message downloader cannot extract photo'); } };
  const archive = backup.archive;
  client.downloadMedia = async (target, args) => {
    assert.equal(target, photo);
    assert.equal(args.thumb, 'c');
    await args.outputFile.write(bytes);
  };
  await backup.enable('123');
  const blob = await downloadArchiveMedia({ client, message, media: archiveMedia(message), archive,
    sourceId: '123', maxFileBytes: 1000000 });
  assert.equal(blob.size, bytes.length);
  assert.equal(blob.sha256, hash(bytes));
});

test('manual backup drains pending media without enabling persistent capture, including on failure', async (t) => {
  const f = await fixture(t, { remote: [voice(1), voice(2), voice(3)] });
  await f.backup.enable('123');
  await f.backup.pause('123');
  f.config.backupMediaBatchSize = 1;
  let destroyed = 0;
  f.client.destroy = async () => { destroyed++; };
  const result = await f.backup.runOnce('123', { pages: 1 });
  assert.ok(destroyed >= 2);
  assert.equal(result.captureEnabled, false);
  assert.equal(result.media.saved, 3);
  assert.equal(result.history.complete, true);
  f.offline();
  await assert.rejects(f.backup.runOnce('123'), /offline/);
  assert.equal((await f.backup.status('123')).captureEnabled, false);
  await f.backup.captureIndexed([{ sourceId: '123', messageId: 999, text: 'must stay outside paused archive' }]);
  assert.equal((await f.backup.search({ sourceId: '123', query: 'must stay' })).messages.length, 0);
});

test('daily backup skips unchanged index and sync timestamps without opening Telegram or appending records', async (t) => {
  const f = await fixture(t, { indexed: [{ sourceId: '123', messageId: 1, text: 'hello', updatedAt: new Date(0) }],
    remote: [textMessage(1, 'hello')] });
  await f.backup.enable('123'); await f.backup.pause('123');
  assert.equal((await runDailyBackup({ backup: f.backup, store: f.store, sourceId: '123' })).status, 'updated');
  const before = await f.backup.status('123');
  const fingerprint = await indexFingerprint(f.store, '123');
  f.store.messages[0].updatedAt = new Date();
  assert.equal(await indexFingerprint(f.store, '123'), fingerprint);
  f.offline();
  assert.equal((await runDailyBackup({ backup: f.backup, store: f.store, sourceId: '123' })).status, 'unchanged');
  assert.equal((await f.backup.status('123')).records, before.records);
  await f.store.upsertMessages([{ sourceId: '123', messageId: 1, text: 'hello', transcriptText: 'new transcript' }]);
  await assert.rejects(runDailyBackup({ backup: f.backup, store: f.store, sourceId: '123' }), /offline/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.backup.archive.sourceRoot('123'), 'daily-state.json'))).fingerprint, fingerprint);
  assert.notEqual(await indexFingerprint(f.store, '123'), fingerprint);
  assert.equal((await f.backup.status('123')).captureEnabled, false);
});

test('daily backup processes pending originals even when the index fingerprint is unchanged', async (t) => {
  const f = await fixture(t, { remote: [voice(1)] });
  await f.backup.enable('123'); await f.backup.pause('123');
  await runDailyBackup({ backup: f.backup, store: f.store, sourceId: '123' });
  const state = await f.backup.archive.view('123');
  const media = [...state.latest.values()].find((r) => r.kind === 'media');
  await f.backup.archive.append('123', [{ kind: 'media', key: media.key,
    payload: { ...media.payload, status: 'failed', retryAt: new Date(0).toISOString() } }]);
  const result = await runDailyBackup({ backup: f.backup, store: f.store, sourceId: '123' });
  assert.equal(result.status, 'updated');
  assert.equal(result.media.saved, 1);
});

test('expiring Telegram file references do not create message versions but edits do', async (t) => {
  const f = await fixture(t);
  const archive = f.backup.archive;
  await f.backup.enable('123');
  const payload = { messageId: 1, text: 'original', telegram: { media: { photo: { id: '55', fileReference: { data: [1, 2] } } } } };
  await archive.append('123', [{ kind: 'message', key: '1', payload }]);
  const before = (await archive.view('123')).seq;
  payload.telegram.media.photo.fileReference.data = [3, 4];
  await archive.append('123', [{ kind: 'message', key: '1', payload }]);
  assert.equal((await archive.view('123')).seq, before);
  payload.text = 'edited';
  await archive.append('123', [{ kind: 'message', key: '1', payload }]);
  assert.equal((await archive.view('123')).seq, before + 1);
});

test('backup is exact opt-in, protects purge even when paused, and leaves a second chat alone', async (t) => {
  const { backup, store } = await fixture(t, { indexed: [
    { sourceId: '123', messageId: 1, date: new Date(), text: 'selected' },
    { sourceId: '456', messageId: 1, date: new Date(), text: 'other chat secret' }
  ] });
  await assert.rejects(backup.enable('*'), /exact/);
  await backup.enable('123');
  assert.equal((await backup.search({ sourceId: '123', query: 'secret' })).messages.length, 0);
  await backup.pause('123');
  await store.setSourceEnabled('123', false);
  await assert.rejects(store.purgeSourceData('123'), /protected/);
  await store.purgeSourceData('456');
  assert.equal((await backup.search({ sourceId: '123' })).messages[0].text, 'selected');
  await assert.rejects(backup.status('456'), /no local backup/);
  await backup.enable('456');
  assert.deepEqual((await backup.selected()).map((s) => s.sourceId).sort(), ['123', '456']);
});

test('complete historical pagination ignores normal history filters and incremental backlog has no gaps', async (t) => {
  const remote = Array.from({ length: 9 }, (_, i) => textMessage(i + 1));
  const { backup, calls, setRemote } = await fixture(t, { remote });
  await backup.enable('123');
  await backup.run('123', { pages: 1 });
  assert.equal((await backup.status('123')).history.complete, false);
  for (let i = 0; i < 6; i++) await backup.run('123', { pages: 1 });
  assert.equal((await backup.status('123')).history.complete, true);
  assert.equal((await new ArchiveStore(backup.archive.root).view('123')).latest.get('cursor:history').payload.complete, true);
  assert.equal((await backup.search({ sourceId: '123' })).messages.length, 9);
  setRemote([...remote, ...Array.from({ length: 7 }, (_, i) => textMessage(i + 10))]);
  for (let i = 0; i < 4; i++) await backup.run('123', { pages: 1 });
  assert.deepEqual((await backup.search({ sourceId: '123' })).messages.map((m) => m.messageId).sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.ok(calls.filter((c) => c.reverse).every((c) => c.limit === 2));
});

test('append-only journal preserves A -> B -> A and retries do not duplicate versions', async (t) => {
  const { backup } = await fixture(t);
  await backup.enable('123');
  for (const value of ['A', 'A', 'B', 'A']) await backup.handleUpdate({ className: 'UpdateEditChannelMessage', message: textMessage(1, value) });
  const context = await backup.context({ sourceId: '123', messageId: 1 });
  assert.deepEqual(context.versions.filter((r) => r.kind === 'message').map((r) => r.payload.text), ['A', 'B', 'A']);
  await backup.handleUpdate({ className: 'UpdateDeleteChannelMessages', channelId: '123', messages: [1] });
  assert.equal((await backup.search({ sourceId: '123' })).messages[0].text, 'A');
  assert.equal((await backup.search({ sourceId: '123' })).messages[0].deletedInTelegram.confirmed, true);
  await backup.handleUpdate({ className: 'UpdateDeleteMessages', messages: [1] });
  assert.equal((await backup.context({ sourceId: '123', messageId: 1 })).versions.filter((r) => r.kind === 'deleted').length, 1);
});

test('original audio, transcript and messages survive Telegram deletion and restore from replica', async (t) => {
  const message = voice(2);
  const { backup, config, root, setRemote, offline } = await fixture(t, { remote: [textMessage(1, 'survive'), message] });
  await backup.enable('123');
  await backup.run('123');
  await backup.transcribe({ sourceId: '123' });
  const before = await backup.mediaFile({ sourceId: '123', messageId: 2 });
  assert.equal(before.sha256, hash(message.bytes));
  setRemote([]); offline();
  await assert.rejects(backup.run('123'), /offline/);
  assert.equal((await backup.search({ sourceId: '123', query: 'offline transcript' })).messages.length, 1);
  const snapshot = await backup.replicate('123');
  await verifySnapshot(snapshot.snapshot, '123');
  // Remove all local service data: the verified replica must be sufficient.
  await fs.rm(config.backupDir, { recursive: true });
  const target = path.join(root, 'restored');
  await restoreSnapshot('123', snapshot.snapshot, target);
  const restored = createBackupService({ config: { ...config, backupDir: target } });
  assert.equal((await restored.status('123')).captureEnabled, false);
  assert.equal((await restored.search({ sourceId: '123', query: 'survive' })).messages.length, 1);
  assert.equal((await restored.search({ sourceId: '123', query: 'offline transcript' })).messages.length, 1);
  const after = await restored.mediaFile({ sourceId: '123', messageId: 2 });
  assert.deepEqual(await fs.readFile(after.filePath), message.bytes);
  await assert.rejects(restoreSnapshot('123', snapshot.snapshot, target), /must not exist/);
});

test('Mongo-index transcripts are seeded, and changed audio never inherits old transcript', async (t) => {
  const original = voice(1);
  const { backup, store, setRemote } = await fixture(t, { indexed: [{ sourceId: '123', messageId: 1,
    date: new Date(), text: '', media: archiveMedia(original), transcriptText: 'old transcript', transcription: { status: 'done' } }], remote: [original] });
  await backup.enable('123');
  await backup.run('123');
  assert.equal((await backup.search({ sourceId: '123', query: 'old transcript' })).messages.length, 1);
  const changed = voice(1, Buffer.from('replacement'));
  changed.document.id = 'new-audio';
  setRemote([changed]);
  await backup.handleUpdate({ className: 'UpdateEditChannelMessage', message: changed });
  await backup.run('123');
  assert.equal((await backup.search({ sourceId: '123', query: 'old transcript' })).messages.length, 0);
  assert.ok((await backup.context({ sourceId: '123', messageId: 1 })).versions.some((r) => r.kind === 'transcript' && r.payload.transcriptText === 'old transcript'));
  await store.completeAudioTranscription({ sourceId: '123', messageId: 1, transcriptText: 'later old transcript' });
  assert.equal((await backup.search({ sourceId: '123', query: 'later old' })).messages.length, 0);
});

test('media failures remain visible and do not prevent text history completion', async (t) => {
  const large = voice(1); large.document.size = 9 * 1024 ** 3;
  const { backup } = await fixture(t, { remote: [large, textMessage(2, 'kept')] });
  await backup.enable('123');
  await backup.run('123');
  const status = await backup.status('123');
  assert.equal(status.history.complete, true);
  assert.equal(status.media.blocked_by_limit, 1);
  assert.equal((await backup.search({ sourceId: '123', query: 'kept' })).messages.length, 1);
});

test('archive photo downloader never silently selects a smaller photo to fit limits', async (t) => {
  const { backup, client } = await fixture(t);
  await backup.enable('123');
  const message = { ...textMessage(1), photo: { id: 'photo-1', sizes: [
    { w: 10, h: 10, size: 5, type: 's' }, { w: 1000, h: 1000, size: 5000, type: 'y' }
  ] } };
  const media = archiveMedia(message);
  assert.equal(media.variant, 'y');
  await assert.rejects(downloadArchiveMedia({ client, message, media, archive: backup.archive, sourceId: '123', maxFileBytes: 100 }), /exceeds/);
});

test('verify detects corrupted blobs and tampered journal; incomplete snapshot cannot restore', async (t) => {
  const { backup, root } = await fixture(t, { remote: [voice(1)] });
  await backup.enable('123'); await backup.run('123');
  const snapshot = await backup.replicate('123');
  const media = await backup.mediaFile({ sourceId: '123', messageId: 1 });
  await fs.writeFile(media.filePath, 'corrupt');
  await assert.rejects(backup.verify('123'), /integrity/);
  const replicaBlob = path.join(snapshot.snapshot, '123', 'blobs', media.sha256);
  await fs.rm(replicaBlob);
  await assert.rejects(restoreSnapshot('123', snapshot.snapshot, path.join(root, 'bad-restore')));
  const state = await backup.archive.view('123');
  await fs.appendFile(path.join(backup.archive.sourceRoot('123'), 'records', state.records[0].file), ' ');
  await assert.rejects(new ArchiveStore(backup.archive.root).verify('123'), /journal integrity/);
});

test('replica cannot be nested in local archive; interrupted metadata append resumes on a fresh instance', async (t) => {
  const { backup } = await fixture(t);
  await backup.enable('123');
  await assert.rejects(exportSnapshot(backup.archive, '123', path.join(backup.archive.root, 'nested')), /separate/);
  await fs.writeFile(path.join(backup.archive.sourceRoot('123'), 'records', 'interrupted.partial'), 'incomplete');
  const restarted = new ArchiveStore(backup.archive.root);
  await restarted.append('123', [{ kind: 'message', key: '1', payload: { text: 'resumed' } }]);
  assert.equal((await restarted.view('123')).latest.get('message:1').payload.text, 'resumed');
  await restarted.verify('123');
});

test('concurrent archive writers serialize and leases cannot release a different owner', async (t) => {
  const { backup, store } = await fixture(t);
  await backup.enable('123');
  const second = new ArchiveStore(backup.archive.root);
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? second : backup.archive)
    .append('123', [{ kind: 'message', key: String(i), payload: { text: String(i) } }])));
  await backup.archive.verify('123');
  const state = await second.view('123', { fresh: true });
  assert.equal([...state.latest.values()].filter((r) => r.kind === 'message').length, 12);
  await store.claimSourceSync('123', { owner: 'other', lockUntil: new Date(Date.now() + 60000) });
  await store.releaseBackupLease('123', 'wrong');
  assert.equal(store.sources[0].syncLockOwner, 'other');
  assert.equal(await store.renewBackupLease('123', 'wrong', new Date()), false);
  assert.equal((await backup.run('123')).status, 'busy');
});

test('legacy cache bytes survive cache expiry and export but are not presented as verified originals', async (t) => {
  const photo = { kind: 'photo', photoId: 'old-photo', mimeType: 'image/jpeg' };
  const f = await fixture(t, { indexed: [{ sourceId: '123', messageId: 1, text: '', date: new Date(), media: photo }] });
  f.config.imageCacheDir = path.join(f.root, 'cache');
  let now = new Date();
  const cache = createImageCache({ config: f.config, store: f.store, now: () => now });
  const bytes = Buffer.from('cached image');
  await cache.storeBuffer({ sourceId: '123', messageId: 1, mimeType: 'image/jpeg', buffer: bytes });
  await f.backup.enable('123');
  now = new Date(now.getTime() + 31 * 86400000);
  await cache.cleanup();
  const item = await f.backup.mediaFile({ sourceId: '123', messageId: 1 });
  assert.equal(item.original, false);
  assert.deepEqual(await fs.readFile(item.filePath), bytes);
  const snapshot = await f.backup.replicate('123');
  await verifySnapshot(snapshot.snapshot, '123');
});

test('two explicitly protected chats export independently, and an unselected third chat never enters the journal', async (t) => {
  const f = await fixture(t, { indexed: [
    { sourceId: '123', messageId: 1, date: new Date(), text: 'first' },
    { sourceId: '456', messageId: 1, date: new Date(), text: 'second' },
    { sourceId: '789', messageId: 1, date: new Date(), text: 'third secret' }
  ] });
  await f.backup.enable('123'); await f.backup.enable('456');
  await f.store.upsertMessages([{ sourceId: '456', messageId: 2, date: new Date(), text: 'second addition' }]);
  const snapshot = await f.backup.replicate('123');
  const manifest = JSON.parse(await fs.readFile(path.join(snapshot.snapshot, 'manifest.json')));
  assert.ok(manifest.files.every((entry) => entry.path.startsWith('123/')));
  assert.equal((await f.backup.search({ sourceId: '456', query: 'addition' })).messages.length, 1);
  assert.equal((await f.backup.search({ sourceId: '123', query: 'second' })).messages.length, 0);
  assert.equal((await f.backup.search({ sourceId: '123', query: 'third' })).messages.length, 0);
  const before = await f.backup.archive.verify('123');
  f.backup.archive.minFreeBytes = Number.MAX_SAFE_INTEGER;
  await assert.rejects(f.backup.archive.append('123', [{ kind: 'message', key: '5', payload: {} }]), /disk space/);
  f.backup.archive.minFreeBytes = 0;
  assert.deepEqual(await f.backup.archive.verify('123'), before);
});

test('a dead writer lock is recovered without modifying committed records', async (t) => {
  const { backup } = await fixture(t);
  await backup.enable('123');
  const lock = path.join(backup.archive.root, '.writer-lock');
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  await backup.archive.append('123', [{ kind: 'message', key: '1', payload: { text: 'recovered' } }]);
  assert.equal((await backup.archive.view('123')).latest.get('message:1').payload.text, 'recovered');
  await backup.verify('123');
});

test('a normal index media replacement cannot bind a retained old transcript to the new archive media', async (t) => {
  const oldMessage = voice(1);
  const f = await fixture(t, { indexed: [{ sourceId: '123', messageId: 1, date: new Date(), text: '',
    media: archiveMedia(oldMessage), transcriptText: 'old words', transcription: { status: 'done' } }], remote: [oldMessage] });
  await f.backup.enable('123'); await f.backup.run('123');
  const nextMessage = voice(1, Buffer.from('new audio'));
  nextMessage.document.id = 'different-file';
  f.setRemote([nextMessage]);
  await f.store.upsertMessages([{ sourceId: '123', messageId: 1, date: new Date(), text: '', media: archiveMedia(nextMessage) }]);
  await f.backup.handleUpdate({ className: 'UpdateEditChannelMessage', message: nextMessage });
  await f.backup.run('123');
  assert.equal((await f.backup.search({ sourceId: '123', query: 'old words' })).messages.length, 0);
  await f.backup.transcribe({ sourceId: '123' });
  await f.backup.run('123');
  assert.equal((await f.backup.search({ sourceId: '123', query: 'offline transcript' })).messages.length, 1);
});
