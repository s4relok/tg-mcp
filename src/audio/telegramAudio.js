import fsp from 'node:fs/promises';
import path from 'node:path';

const MIME_EXTENSIONS = new Map([
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/x-m4a', '.m4a'],
  ['audio/ogg', '.ogg'],
  ['audio/opus', '.ogg'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/webm', '.webm'],
  ['video/mp4', '.mp4']
]);

function safePart(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'audio';
}

function extensionFromMedia(media = {}) {
  const fileName = media.fileName || '';
  const fileExtension = path.extname(fileName);
  if (fileExtension) {
    return fileExtension;
  }
  return MIME_EXTENSIONS.get(media.mimeType || '') || '.audio';
}

export async function getTelegramMessageById({ client, sourceId, messageId }) {
  const messages = await client.getMessages(sourceId, { ids: messageId });
  if (Array.isArray(messages)) {
    return messages[0] || null;
  }
  return messages?.[0] || messages || null;
}

export async function downloadTelegramAudioMessage({
  client,
  message,
  job,
  workDir
}) {
  if (!message) {
    throw new Error(`Telegram message was not found: ${job.sourceId}/${job.messageId}`);
  }

  const media = job.media || {};
  const fileName = [
    safePart(job.sourceId),
    safePart(job.messageId),
    Date.now()
  ].join('-') + extensionFromMedia(media);
  await fsp.mkdir(workDir, { recursive: true });
  const filePath = path.join(workDir, fileName);

  const downloaded = typeof message.downloadMedia === 'function'
    ? await message.downloadMedia({ outputFile: filePath })
    : await client.downloadMedia(message, { outputFile: filePath });
  const outputPath = typeof downloaded === 'string' ? downloaded : filePath;
  if (Buffer.isBuffer(downloaded)) {
    await fsp.writeFile(outputPath, downloaded);
  }
  const stat = await fsp.stat(outputPath);
  if (stat.size === 0) {
    throw new Error(`Telegram media download produced an empty file: ${job.sourceId}/${job.messageId}`);
  }

  return {
    filePath: outputPath,
    size: stat.size
  };
}
