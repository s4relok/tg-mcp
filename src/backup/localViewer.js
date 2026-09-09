import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ArchiveStore, exactSourceId, fileHash } from './archiveStore.js';
import { verifySnapshot } from './snapshots.js';
import { createBackupService } from './backupService.js';

const assets = fileURLToPath(new URL('./viewer/', import.meta.url));
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf' };

async function publish(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents);
  await fs.rename(temporary, file);
}

export function viewerHtml(template, data) {
  // Chat text is untrusted, including closing script tags. It is rendered only as textContent.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return template.replace('<!--ARCHIVE_DATA-->', () => json);
}

export async function buildLocalViewer({ destination, sourceIds }) {
  if (!sourceIds?.length) throw new Error('Pass explicit source IDs for the local viewer');
  const root = await fs.realpath(path.resolve(destination));
  const output = path.join(root, 'Просмотр');
  const mediaRoot = path.join(output, 'media');
  await fs.mkdir(mediaRoot, { recursive: true });
  for (const directory of [output, mediaRoot]) {
    if (await fs.realpath(directory) !== directory) throw new Error('Viewer directories must not be symbolic links');
  }
  const chats = [];
  const copied = new Set();
  for (const sourceId of [...new Set(sourceIds.map(exactSourceId))]) {
    const chatRoot = path.join(root, sourceId);
    const candidates = [];
    for (const entry of await fs.readdir(chatRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.endsWith('.partial')) continue;
      const snapshot = path.join(chatRoot, entry.name);
      let manifest;
      try { manifest = JSON.parse(await fs.readFile(path.join(snapshot, 'manifest.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (manifest.sourceId !== sourceId || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Invalid viewer snapshot');
      candidates.push({ snapshot, manifest });
    }
    candidates.sort((a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt)
      || b.manifest.records - a.manifest.records);
    if (!candidates.length) throw new Error(`No complete snapshot for ${sourceId}`);
    const { snapshot, manifest } = candidates[0];
    await verifySnapshot(snapshot, sourceId);
    const archive = new ArchiveStore(snapshot);
    const backup = createBackupService({ config: { backupDir: snapshot }, archive });
    const messages = [];
    let beforeMessageId;
    do {
      const page = await backup.search({ sourceId, limit: 200, beforeMessageId });
      messages.push(...page.messages);
      beforeMessageId = page.nextBeforeMessageId;
    } while (beforeMessageId);
    const state = await archive.view(sourceId);
    const attachments = new Map();
    for (const record of state.latest.values()) {
      if (!['media', 'cached_media'].includes(record.kind)) continue;
      const item = record.payload;
      const metadata = item.media || {};
      const mime = String(metadata.mimeType || item.mimeType || '').toLowerCase().split(';')[0];
      const kind = mime.startsWith('image/') || metadata.kind === 'photo' ? 'image'
        : mime.startsWith('audio/') || ['voice', 'audio'].includes(metadata.kind) ? 'audio'
          : mime.startsWith('video/') ? 'video' : 'file';
      const extension = extensions[mime] || (kind === 'image' ? 'jpg' : kind === 'audio' ? 'ogg' : 'bin');
      const attachment = { status: item.status, kind, mime, original: record.kind !== 'cached_media' && item.original !== false,
        name: metadata.fileName || item.fileName || `${sourceId}-${item.messageId}.${extension}`, size: item.size || metadata.size || 0 };
      if (item.status === 'saved') {
        if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid media hash');
        const filename = `${item.sha256}.${extension}`;
        const file = path.join(mediaRoot, filename);
        if (!copied.has(filename)) {
          let exists = false;
          try {
            if (!(await fs.lstat(file)).isFile()) throw new Error('Viewer media must be regular files');
            exists = await fileHash(file) === item.sha256;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!exists) {
            // Independent copies: opening/editing an exported file cannot change backup hard links.
            const temporary = `${file}.${randomUUID()}.tmp`;
            await fs.copyFile(archive.blobPath(sourceId, item.sha256), temporary, fs.constants.COPYFILE_EXCL);
            if (await fileHash(temporary) !== item.sha256) throw new Error('Viewer media checksum mismatch');
            await fs.rename(temporary, file);
          }
          copied.add(filename);
        }
        attachment.url = `media/${filename}`;
      }
      const messageId = Number(item.messageId ?? record.key.split(':')[0]);
      const list = attachments.get(messageId) || [];
      if (!list.some((a) => a.url && a.url === attachment.url)) list.push(attachment);
      attachments.set(messageId, list);
    }
    chats.push({ sourceId, title: messages.find((m) => m.sourceTitle)?.sourceTitle || sourceId,
      snapshotAt: manifest.createdAt,
      messages: messages.map((m) => ({ id: m.messageId, date: m.date, sender: m.senderName || m.senderId || '',
        text: m.text || '', transcript: m.transcriptText || '', deleted: Boolean(m.deletedInTelegram),
        replyTo: m.replyToMessageId || null, attachments: attachments.get(m.messageId) || [] })) });
  }
  const data = { generatedAt: new Date().toISOString(), chats };
  for (const name of ['app.js', 'style.css']) await publish(path.join(output, name), await fs.readFile(path.join(assets, name)));
  const html = viewerHtml(await fs.readFile(path.join(assets, 'index.html'), 'utf8'), data);
  await publish(path.join(output, 'index.html'), html);
  return { viewer: path.join(output, 'index.html'), chats: chats.length,
    messages: chats.reduce((sum, chat) => sum + chat.messages.length, 0), mediaFiles: copied.size };
}
