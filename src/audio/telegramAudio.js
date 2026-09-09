import fsp from 'node:fs/promises';
import path from 'node:path';
import { downloadTelegramFile } from '../telegram/mediaDownload.js';

const MIME_EXTENSIONS = new Map([
  ['audio/aac', '.aac'],
  ['audio/flac', '.flac'],
  ['audio/x-flac', '.flac'],
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

const MCP_AUDIO_MIME_TYPES = new Set(
  [...MIME_EXTENSIONS.keys()].filter((mimeType) => mimeType.startsWith('audio/'))
);

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

export function normalizeMcpAudioMimeType(value) {
  const mimeType = String(value || '').trim().toLowerCase().split(';', 1)[0];
  return MCP_AUDIO_MIME_TYPES.has(mimeType) ? mimeType : null;
}

export function mcpAudioExtension(mimeType) {
  return MIME_EXTENSIONS.get(normalizeMcpAudioMimeType(mimeType)) || '.audio';
}

export function telegramMessageAudioDocument(message) {
  const direct = message?.voice || message?.audio || null;
  if (direct) {
    return direct;
  }
  const document = message?.document || message?.media?.document || null;
  const attributes = document?.attributes || [];
  return attributes.some((attribute) => (
    attribute?.className === 'DocumentAttributeAudio'
    || attribute?.constructor?.name === 'DocumentAttributeAudio'
  ))
    ? document
    : null;
}

const sourceEntityCache = new WeakMap();

function telegramEntityId(entity) {
  const id = entity?.id;
  if (id === undefined || id === null) {
    return '';
  }
  return typeof id.toString === 'function' ? id.toString() : String(id);
}

export async function resolveTelegramSourceEntity({ client, sourceId }) {
  const normalizedSourceId = String(sourceId);
  let cachedBySource = sourceEntityCache.get(client);
  if (!cachedBySource) {
    cachedBySource = new Map();
    sourceEntityCache.set(client, cachedBySource);
  }

  if (cachedBySource.has(normalizedSourceId)) {
    return cachedBySource.get(normalizedSourceId);
  }

  const dialogs = await client.getDialogs({});
  const dialog = dialogs.find((candidate) => {
    const entity = candidate?.entity || candidate;
    return telegramEntityId(entity) === normalizedSourceId;
  });
  if (!dialog) {
    throw new Error(`Telegram source was not found in authorized dialogs: ${normalizedSourceId}`);
  }

  const entity = dialog.entity || dialog;
  cachedBySource.set(normalizedSourceId, entity);
  return entity;
}

export async function getTelegramMessageById({ client, sourceId, messageId }) {
  const entity = await resolveTelegramSourceEntity({ client, sourceId });
  const messages = await client.getMessages(entity, { ids: messageId });
  if (Array.isArray(messages)) {
    return messages[0] || null;
  }
  return messages?.[0] || messages || null;
}

export async function downloadTelegramAudioMessage({
  client,
  message,
  job,
  workDir,
  maxFileBytes
}) {
  if (!message) {
    throw new Error(`Telegram message was not found: ${job.sourceId}/${job.messageId}`);
  }

  const media = job.media || {};
  if (
    maxFileBytes
    && Number.isFinite(Number(media.size))
    && Number(media.size) > maxFileBytes
  ) {
    throw new Error(`Audio exceeds the ${maxFileBytes} byte limit`);
  }
  const fileName = [
    safePart(job.sourceId),
    safePart(job.messageId),
    Date.now()
  ].join('-') + extensionFromMedia(media);
  await fsp.mkdir(workDir, { recursive: true });
  const filePath = path.join(workDir, fileName);

  try {
    return await downloadTelegramFile({ client, message, filePath, maxFileBytes });
  } catch (error) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
}
