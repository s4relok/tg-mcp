import { resolveEligibleSource } from '../services/sourceAccess.js';

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
  store
}) {
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
      const images = messages.map((message) => publicImageMessage(message));

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
    }
  };
}

export { publicImageMessage };
