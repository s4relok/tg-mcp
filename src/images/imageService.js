import { resolveEligibleSource } from '../services/sourceAccess.js';
import { createAuthorizedTelegramClient } from '../telegram/telegramSync.js';
import {
  downloadTelegramImageMessage,
  getTelegramMessageById
} from './telegramImage.js';

function boundedLimit(value, fallback, maximum) {
  const limit = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`limit must be an integer between 1 and ${maximum}`);
  }
  return limit;
}

function optionalDate(value, name) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${name} must be a valid ISO date or datetime`);
  }
  return date;
}

function publicImageMessage(message, cacheEntry = null) {
  return {
    sourceId: message.sourceId,
    messageId: message.messageId,
    date: new Date(message.date).toISOString(),
    senderName: message.senderName || null,
    text: message.text || '',
    transcriptText: message.transcriptText || '',
    link: message.link || null,
    groupedId: message.raw?.groupedId || null,
    media: {
      kind: message.media.kind,
      mimeType: message.media.mimeType || null,
      size: message.media.size ?? null,
      width: message.media.width ?? null,
      height: message.media.height ?? null,
      fileName: message.media.fileName || null,
      cached: Boolean(cacheEntry),
      cachedAt: cacheEntry?.cachedAt
        ? new Date(cacheEntry.cachedAt).toISOString()
        : null,
      expiresAt: cacheEntry?.expiresAt
        ? new Date(cacheEntry.expiresAt).toISOString()
        : null
    }
  };
}

export function createTelegramImageService({
  config,
  store,
  cache = null,
  createClient = createAuthorizedTelegramClient,
  getMessage = getTelegramMessageById,
  downloadImage = downloadTelegramImageMessage
}) {
  async function cacheInfoByMessage(messages) {
    const byMessageId = new Map();
    if (!cache) {
      return byMessageId;
    }
    for (const message of messages) {
      const cached = await cache.getValidEntry(
        message.sourceId,
        message.messageId,
        { readData: false }
      );
      if (cached) {
        byMessageId.set(message.messageId, cached.entry);
      }
    }
    return byMessageId;
  }

  async function downloadAndCache({ client, message }) {
    if (!cache) {
      throw new Error('Image cache is not configured');
    }
    const telegramMessage = await getMessage({
      client,
      sourceId: message.sourceId,
      messageId: message.messageId
    });
    const downloaded = await downloadImage({
      client,
      message: telegramMessage,
      metadata: message,
      maxFileBytes: config.mcpImageMaxFileBytes || 10 * 1024 * 1024
    });
    const entry = await cache.storeBuffer({
      sourceId: message.sourceId,
      messageId: message.messageId,
      mimeType: downloaded.mimeType,
      buffer: downloaded.buffer
    });
    return {
      entry,
      buffer: downloaded.buffer
    };
  }

  return {
    async listSourceImages({
      sourceId,
      from,
      to,
      beforeMessageId,
      limit
    } = {}) {
      const eligibility = await resolveEligibleSource({ store, config, sourceId });
      if (!eligibility.eligible) {
        return {
          status: 'rejected',
          sourceId: eligibility.sourceId,
          reason: eligibility.reason,
          message: eligibility.message,
          images: []
        };
      }
      const effectiveLimit = boundedLimit(
        limit,
        20,
        config.mcpImageListMaxLimit || 100
      );
      const fromDate = optionalDate(from, 'from');
      const toDate = optionalDate(to, 'to');
      if (fromDate && toDate && fromDate >= toDate) {
        throw new Error('from must be earlier than to');
      }
      const messages = await store.listSourceImages({
        sourceId: eligibility.sourceId,
        from: fromDate,
        to: toDate,
        beforeMessageId,
        limit: effectiveLimit
      });
      const cacheByMessageId = await cacheInfoByMessage(messages);
      const images = messages.map((message) => publicImageMessage(
        message,
        cacheByMessageId.get(message.messageId) || null
      ));

      return {
        status: 'ok',
        sourceId: eligibility.sourceId,
        sourceTitle: eligibility.source.title,
        count: images.length,
        images,
        nextBeforeMessageId: images.length === effectiveLimit
          ? images.at(-1).messageId
          : null,
        hint: images.length
          ? null
          : 'No synchronized images were found. Call sync_source for this exact source when fresh or historical Telegram images are needed.'
      };
    },

    async cacheSourceImages({ sourceId, client, limit } = {}) {
      const eligibility = await resolveEligibleSource({ store, config, sourceId });
      if (!eligibility.eligible) {
        return {
          status: 'rejected',
          sourceId: eligibility.sourceId,
          reason: eligibility.reason,
          requested: 0,
          cached: 0,
          alreadyCached: 0,
          failed: 0,
          results: []
        };
      }
      if (!cache) {
        return {
          status: 'error',
          sourceId: eligibility.sourceId,
          error: 'Image cache is not configured',
          requested: 0,
          cached: 0,
          alreadyCached: 0,
          failed: 0,
          results: []
        };
      }
      const effectiveLimit = boundedLimit(
        limit,
        config.mcpImageCacheMaxItemsPerSync || 100,
        config.mcpImageCacheMaxItemsPerSync || 100
      );
      const messages = await store.listSourceImages({
        sourceId: eligibility.sourceId,
        limit: effectiveLimit
      });
      const results = [];
      for (const message of messages) {
        const cached = await cache.getValidEntry(
          eligibility.sourceId,
          message.messageId,
          { readData: false }
        );
        if (cached) {
          results.push({
            messageId: message.messageId,
            status: 'already_cached',
            expiresAt: new Date(cached.entry.expiresAt).toISOString()
          });
          continue;
        }
        try {
          const downloaded = await downloadAndCache({ client, message });
          results.push({
            messageId: message.messageId,
            status: 'cached',
            size: downloaded.entry.size,
            expiresAt: new Date(downloaded.entry.expiresAt).toISOString()
          });
        } catch (error) {
          results.push({
            messageId: message.messageId,
            status: 'failed',
            error: error.message
          });
        }
      }
      const cachedCount = results.filter((result) => result.status === 'cached').length;
      const alreadyCached = results.filter(
        (result) => result.status === 'already_cached'
      ).length;
      const failed = results.filter((result) => result.status === 'failed').length;
      return {
        status: failed ? (cachedCount || alreadyCached ? 'partial' : 'error') : 'ok',
        sourceId: eligibility.sourceId,
        sourceTitle: eligibility.source.title,
        requested: messages.length,
        cached: cachedCount,
        alreadyCached,
        failed,
        results
      };
    },

    async getTelegramImages({ sourceId, messageIds = [] } = {}) {
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
      const maximumItems = config.mcpImageGetMaxItems || 5;
      if (
        !Array.isArray(messageIds)
        || messageIds.length < 1
        || messageIds.length > maximumItems
        || messageIds.some((messageId) => !Number.isInteger(messageId) || messageId < 1)
      ) {
        throw new Error(`messageIds must contain between 1 and ${maximumItems} positive integers`);
      }
      if (!cache) {
        return {
          status: 'error',
          sourceId: eligibility.sourceId,
          error: 'Image cache is not configured',
          items: []
        };
      }

      const messages = await store.getImageMessages({
        sourceId: eligibility.sourceId,
        messageIds
      });
      const byMessageId = new Map(messages.map((message) => [message.messageId, message]));
      const maxTotalBytes = config.mcpImageMaxTotalBytes || 25 * 1024 * 1024;
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
              error: 'Image message was not found in this source.'
            });
            continue;
          }

          try {
            let cached = await cache.getValidEntry(
              eligibility.sourceId,
              messageId,
              { readData: true }
            );
            let cacheHit = true;
            if (!cached) {
              cacheHit = false;
              if (!client) {
                client = await createClient(config);
              }
              cached = await downloadAndCache({ client, message });
            }
            if (totalBytes + cached.buffer.length > maxTotalBytes) {
              items.push({
                messageId,
                status: 'error',
                error: `Image batch exceeds the ${maxTotalBytes} byte response limit.`
              });
              continue;
            }
            totalBytes += cached.buffer.length;
            items.push({
              messageId,
              status: 'ok',
              cacheHit,
              image: publicImageMessage(message, cached.entry),
              mimeType: cached.entry.mimeType,
              size: cached.buffer.length,
              data: cached.buffer.toString('base64')
            });
          } catch (error) {
            items.push({
              messageId,
              status: 'error',
              error: error.message
            });
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
        sourceTitle: eligibility.source.title,
        requested: messageIds.length,
        succeeded,
        failed,
        totalBytes,
        items
      };
    }
  };
}

export { publicImageMessage };
