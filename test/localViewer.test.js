import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore, fileHash } from '../src/backup/archiveStore.js';
import { exportSnapshot } from '../src/backup/snapshots.js';
import { buildLocalViewer, viewerHtml } from '../src/backup/localViewer.js';
import { mediaKey } from '../src/backup/telegramBackup.js';

test('viewer opens latest complete selected snapshot and exports independent media with transcripts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-viewer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = new ArchiveStore(path.join(root, 'server'));
  await archive.select('123');
  const destination = path.join(root, 'pc');
  const photo = { kind: 'photo', photoId: '55', mimeType: 'image/jpeg' };
  const voice = { kind: 'voice', documentId: '66', mimeType: 'audio/ogg' };
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'image fixture');
  const blob = await archive.saveBlob('123', file);
  await archive.append('123', [{ kind: 'message', key: '1', payload: { sourceTitle: 'Fixture', messageId: 1, text: 'old' } }]);
  await exportSnapshot(archive, '123', path.join(destination, '123'));
  await archive.append('123', [
    { kind: 'message', key: '1', payload: { sourceTitle: 'Fixture', messageId: 1, text: '</script><script>evil()</script>', media: photo } },
    { kind: 'media', key: `1:${mediaKey(photo)}`, payload: { messageId: 1, media: photo, ...blob, status: 'saved' } },
    { kind: 'message', key: '2', payload: { messageId: 2, text: '', media: voice } },
    { kind: 'media', key: `2:${mediaKey(voice)}`, payload: { messageId: 2, media: voice, status: 'unavailable' } },
    { kind: 'transcript', key: `2:${mediaKey(voice)}`, payload: { transcriptText: 'still searchable' } }
  ]);
  const latest = await exportSnapshot(archive, '123', path.join(destination, '123'));
  await fs.mkdir(path.join(destination, '123', 'newest.partial'));
  await fs.mkdir(path.join(destination, '456')); // Unselected sources must not be loaded.
  const result = await buildLocalViewer({ destination, sourceIds: ['123'] });
  assert.equal(result.chats, 1);
  assert.equal(result.messages, 2);
  assert.equal(result.mediaFiles, 1);
  const html = await fs.readFile(result.viewer, 'utf8');
  assert.ok(!html.includes('<script>evil()'));
  const data = JSON.parse(html.match(/id="archive-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const messages = data.chats[0].messages;
  assert.equal(messages.find((m) => m.id === 1).text, '</script><script>evil()</script>');
  assert.equal(messages.find((m) => m.id === 2).transcript, 'still searchable');
  assert.equal(messages.find((m) => m.id === 2).attachments[0].status, 'unavailable');
  const exported = path.join(path.dirname(result.viewer), messages.find((m) => m.id === 1).attachments[0].url);
  assert.equal(path.extname(exported), '.jpg');
  assert.equal(await fileHash(exported), blob.sha256);
  await fs.writeFile(exported, 'user edited exported image');
  assert.equal(await fileHash(path.join(latest.snapshot, '123', 'blobs', blob.sha256)), blob.sha256);
  await buildLocalViewer({ destination, sourceIds: ['123'] });
  assert.equal(await fileHash(exported), blob.sha256);
  assert.equal((await new ArchiveStore(latest.snapshot).view('123')).seq, latest.records);
});

test('viewer data cannot close its JSON script or inject executable markup', () => {
  const data = { text: '</script><img src=x onerror=evil()>$&\u2028\u2029' };
  const html = viewerHtml('<script type="application/json"><!--ARCHIVE_DATA--></script>', data);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.equal(JSON.parse(html.slice(html.indexOf('>') + 1, html.lastIndexOf('<'))).text, data.text);
});
