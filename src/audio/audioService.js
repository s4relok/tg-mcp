import fsp from 'node:fs/promises';
import path from 'node:path';

import { resolveEligibleSource } from '../services/sourceAccess.js';
import { createAuthorizedTelegramClient } from '../telegram/telegramSync.js';
import {
  downloadTelegramAudioMessage,
  getTelegramMessageById,
  mcpAudioExtension,
  normalizeMcpAudioMimeType,
  telegramMessageAudioDocument
} from './telegramAudio.js';

function safeFileName(message, mimeType) {
  const configured = path.basename(String(message.media?.fileName || '')).trim();
  const safeConfigured = configured
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  const extension = mcpAudioExtension(mimeType);
  if (safeConfigured) {
    const configuredExtension = path.extname(safeConfigured);
    const stem = configuredExtension
      ? safeConfigured.slice(0, -configuredExtension.length)
      : safeConfigured;
    return `${stem || `telegram-audio-${message.messageId}`}${extension}`;
  }
  return `telegram-audio-${message.messageId}${extension}`;
}

function publicAudioMessage(message, { mimeType, size, fileName }) {
  return {
    sourceId: message.sourceId,
    messageId: message.messageId,
    date: new Date(message.date).toISOString(),
    media: {
      kind: message.media.kind,
      mimeType,
      size,
      durationSec: message.media.durationSec ?? null,
      fileName
    }
  };
}

async function removeTemporaryAudio(filePath) {
  if (filePath) {
    await fsp.rm(filePath, { force: true });
  }
}

function safeTemporaryAudioPath(workDir, filePath) {
  const root = path.resolve(workDir);
  const resolved = path.resolve(filePath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Audio downloader returned a path outside the private work directory.');
  }
  return resolved;
}

export function createTelegramAudioService({
  config,
  store,
  createClient = createAuthorizedTelegramClient,
  getMessage = getTelegramMessageById,
  downloadAudio = downloadTelegramAudioMessage
}) {
  return {
    async getTelegramAudio({ sourceId, messageIds = [] } = {}) {
      const eligibility = await resolveEligibleSource({ store, config, sourceId });
      if (!eligibility.eligible) {
        return {
          status: 'rejected',
          sourceId: eligibility.sourceId,
          reason: eligibility.reason,
          message: eligibility.message,
          items: []
        };
      }

      const maximumItems = config.mcpAudioGetMaxItems || 3;
      if (
        !Array.isArray(messageIds)
        || messageIds.length < 1
        || messageIds.length > maximumItems
        || messageIds.some((messageId) => !Number.isInteger(messageId) || messageId < 1)
      ) {
        throw new Error(`messageIds must contain between 1 and ${maximumItems} positive integers`);
      }
      if (new Set(messageIds).size !== messageIds.length) {
        throw new Error('messageIds must not contain duplicates');
      }

      const messages = await store.getMessagesByIds({
        sourceId: eligibility.sourceId,
        messageIds
      });
      const byMessageId = new Map(messages.map((message) => [message.messageId, message]));
      const maxFileBytes = config.mcpAudioMaxFileBytes || 10 * 1024 * 1024;
      const maxTotalBytes = config.mcpAudioMaxTotalBytes || 20 * 1024 * 1024;
      const workDir = config.audioTranscriptionWorkDir || './tmp/audio-transcriptions';
      let totalBytes = 0;
      let client = null;
      const items = [];

      try {
        for (const messageId of messageIds) {
          const message = byMessageId.get(messageId);
          if (!message) {
            items.push({
              messageId,
              status: 'error',
              error: 'Telegram message was not found in this source.'
            });
            continue;
          }
          if (!['voice', 'audio'].includes(message.media?.kind)) {
            items.push({
              messageId,
              status: 'error',
              error: 'Telegram message is not voice/audio media.'
            });
            continue;
          }

          const storedMimeType = normalizeMcpAudioMimeType(message.media?.mimeType);
          if (!storedMimeType) {
            items.push({
              messageId,
              status: 'error',
              error: `Unsupported audio MIME type: ${message.media?.mimeType || 'unknown'}`
            });
            continue;
          }
          if (
            Number.isFinite(Number(message.media?.size))
            && Number(message.media.size) > maxFileBytes
          ) {
            items.push({
              messageId,
              status: 'error',
              error: `Audio exceeds the ${maxFileBytes} byte limit.`
            });
            continue;
          }

          let temporaryFilePath = null;
          try {
            if (!client) {
              client = await createClient(config);
            }
            const telegramMessage = await getMessage({
              client,
              sourceId: eligibility.sourceId,
              messageId
            });
            if (!telegramMessage) {
              throw new Error('Telegram message no longer exists.');
            }
            const audioDocument = telegramMessageAudioDocument(telegramMessage);
            if (!audioDocument) {
              throw new Error('Live Telegram message is not voice/audio media.');
            }
            const liveMimeType = normalizeMcpAudioMimeType(
              audioDocument.mimeType || audioDocument.mime_type || storedMimeType
            );
            if (!liveMimeType) {
              throw new Error(
                `Unsupported live audio MIME type: ${audioDocument.mimeType || audioDocument.mime_type || 'unknown'}`
              );
            }
            if (
              Number.isFinite(Number(audioDocument.size))
              && Number(audioDocument.size) > maxFileBytes
            ) {
              throw new Error(`Audio exceeds the ${maxFileBytes} byte limit.`);
            }

            const downloaded = await downloadAudio({
              client,
              message: telegramMessage,
              job: {
                sourceId: eligibility.sourceId,
                messageId,
                media: message.media
              },
              workDir,
              maxFileBytes
            });
            temporaryFilePath = safeTemporaryAudioPath(workDir, downloaded.filePath);
            if (downloaded.size > maxFileBytes) {
              throw new Error(`Audio exceeds the ${maxFileBytes} byte limit.`);
            }
            if (totalBytes + downloaded.size > maxTotalBytes) {
              throw new Error(`Audio batch exceeds the ${maxTotalBytes} byte response limit.`);
            }
            const buffer = await fsp.readFile(temporaryFilePath);
            if (buffer.length !== downloaded.size || buffer.length === 0) {
              throw new Error('Downloaded audio size changed before it could be returned.');
            }
            if (buffer.length > maxFileBytes) {
              throw new Error(`Audio exceeds the ${maxFileBytes} byte limit.`);
            }

            const fileName = safeFileName(message, liveMimeType);
            totalBytes += buffer.length;
            items.push({
              messageId,
              status: 'ok',
              audio: publicAudioMessage(message, {
                mimeType: liveMimeType,
                size: buffer.length,
                fileName
              }),
              mimeType: liveMimeType,
              fileName,
              size: buffer.length,
              data: buffer.toString('base64')
            });
          } catch (error) {
            items.push({
              messageId,
              status: 'error',
              error: error.message
            });
          } finally {
            await removeTemporaryAudio(temporaryFilePath);
          }
        }
      } finally {
        if (client && typeof client.disconnect === 'function') {
          await client.disconnect();
        }
      }

      const succeeded = items.filter((item) => item.status === 'ok').length;
      const failed = items.length - succeeded;
      return {
        status: failed ? (succeeded ? 'partial' : 'error') : 'ok',
        sourceId: eligibility.sourceId,
        requested: messageIds.length,
        succeeded,
        failed,
        totalBytes,
        items
      };
    }
  };
}

export { publicAudioMessage };
