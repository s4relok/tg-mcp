import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeTelegramMessage, normalizeTelegramMedia } from '../telegram/telegramSync.js';
import { canonical, hash } from './archiveStore.js';
import { downloadTelegramFile } from '../telegram/mediaDownload.js';

export function archiveMedia(message) {
  const supported = normalizeTelegramMedia(message);
  const document = message.document || message.media?.document;
  const photo = message.photo || message.media?.photo;
  if (photo) {
    const sizes = (photo.sizes || []).filter((size) => Number(size.w) && Number(size.h))
      .sort((a, b) => Number(b.w) * Number(b.h) - Number(a.w) * Number(a.h));
    const largest = sizes[0];
    return {
      ...supported, kind: 'photo', photoId: String(photo.id), mimeType: 'image/jpeg',
      variant: largest?.type || null,
      size: largest?.size ? Number(largest.size) : largest?.sizes?.length ? Math.max(...largest.sizes.map(Number)) : null
    };
  }
  if (document) {
    const filename = (document.attributes || []).find((attr) => attr.className === 'DocumentAttributeFilename');
    return {
      ...(supported || { kind: 'document' }), documentId: String(document.id),
      mimeType: document.mimeType || 'application/octet-stream', size: Number(document.size) || null,
      fileName: supported?.fileName || filename?.fileName || null
    };
  }
  if (message.media && message.media.className !== 'MessageMediaEmpty'
    && message.media.className !== 'MessageMediaWebPage') return { kind: 'unsupported', type: message.media.className || 'unknown' };
  return null;
}

export function mediaKey(media) {
  if (!media) return null;
  // Identity is independent of cached paths, transcription state and estimates.
  return hash(canonical({ kind: media.kind, id: media.documentId || media.photoId || null, type: media.type || null }));
}

export function normalizeArchiveMessage(message, source) {
  const normalized = normalizeTelegramMessage(message, source);
  delete normalized.transcriptText;
  delete normalized.transcription;
  const media = archiveMedia(message);
  return {
    ...normalized, media, mediaKey: mediaKey(media),
    editDate: message.editDate ? new Date(Number(message.editDate) * 1000).toISOString() : null,
    senderName: message.sender?.title || [message.sender?.firstName, message.sender?.lastName].filter(Boolean).join(' ') || null,
    // Telegram TL payload is source-scoped; never serialize a client/session.
    telegram: typeof message.toJSON === 'function' ? message.toJSON() : {
      id: message.id, action: message.action || null, replyTo: message.replyTo || null,
      fwdFrom: message.fwdFrom || null, media: message.media || null
    }
  };
}

export async function downloadArchiveMedia({ client, message, media, archive, sourceId, maxFileBytes }) {
  if (media.kind === 'unsupported') throw Object.assign(new Error('Unsupported Telegram attachment'), { code: 'unsupported' });
  if (media.kind === 'photo' && !media.variant) throw Object.assign(new Error('Largest Telegram photo is unavailable'), { code: 'unavailable' });
  if (media.size > maxFileBytes) throw Object.assign(new Error('Archive file exceeds configured limit'), { code: 'blocked_by_limit' });
  await archive.ensureSpace(media.size || maxFileBytes);
  const work = path.join(archive.sourceRoot(sourceId), 'work');
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  const file = path.join(work, `${randomUUID()}.partial`);
  try {
    const { size } = await downloadTelegramFile({ client, message, filePath: file, maxFileBytes,
      thumb: media.kind === 'photo' ? media.variant : undefined });
    if (media.size && size !== media.size) throw new Error(`Incomplete archive download: expected ${media.size}, received ${size}`);
    return await archive.saveBlob(sourceId, file);
  } finally { await fs.rm(file, { force: true }); }
}
