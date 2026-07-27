import { createAuthorizedTelegramClient } from './telegramSync.js';
import { createSendRichMessageRequest } from './richMessageRequest.js';

const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;
const MAX_TELEGRAM_RICH_MESSAGE_LENGTH = 32768;
const SAVED_MESSAGES_DESTINATION = Object.freeze({ type: 'saved' });
const TELEGRAM_MESSAGE_FORMATS = Object.freeze({
  plainText: 'plain_text',
  richText: 'rich_text'
});

function validateText(text, format) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('text must be a non-empty string');
  }
  const maximumLength = format === TELEGRAM_MESSAGE_FORMATS.richText
    ? MAX_TELEGRAM_RICH_MESSAGE_LENGTH
    : MAX_TELEGRAM_MESSAGE_LENGTH;
  if (text.length > maximumLength) {
    throw new Error(`text must be at most ${maximumLength} characters for ${format}`);
  }
  return text;
}

function validateFormat(format) {
  if (!Object.values(TELEGRAM_MESSAGE_FORMATS).includes(format)) {
    throw new Error('format must be plain_text or rich_text');
  }
  return format;
}

function validateDestination(destination) {
  if (
    !destination
    || typeof destination !== 'object'
    || Array.isArray(destination)
    || destination.type !== SAVED_MESSAGES_DESTINATION.type
  ) {
    throw new Error('Only the saved Telegram destination is supported');
  }
  return SAVED_MESSAGES_DESTINATION;
}

function messageDateIso(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const date = value instanceof Date
    ? value
    : new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createTelegramMessageSender({
  config,
  createClient = createAuthorizedTelegramClient,
  createRichMessageRequest = createSendRichMessageRequest
}) {
  if (typeof createClient !== 'function') {
    throw new Error('createClient is required');
  }
  if (typeof createRichMessageRequest !== 'function') {
    throw new Error('createRichMessageRequest is required');
  }

  return {
    async sendMessage({
      text,
      format = TELEGRAM_MESSAGE_FORMATS.plainText,
      destination = SAVED_MESSAGES_DESTINATION
    } = {}) {
      const messageFormat = validateFormat(format);
      const messageText = validateText(text, messageFormat);
      const target = validateDestination(destination);
      let client = null;

      try {
        client = await createClient(config);
        const sent = messageFormat === TELEGRAM_MESSAGE_FORMATS.richText
          ? await client.invoke(createRichMessageRequest({
            peer: await client.getInputEntity('me'),
            markdown: messageText
          }))
          : await client.sendMessage('me', {
            message: messageText,
            parseMode: false
          });
        return {
          status: 'sent',
          destination: target,
          format: messageFormat,
          messageId: sent.id,
          date: messageDateIso(sent.date),
          ...(sent.messageId !== undefined ? {
            messageId: sent.messageId
          } : {})
        };
      } finally {
        if (client && typeof client.disconnect === 'function') {
          await client.disconnect();
        }
      }
    }
  };
}

export {
  MAX_TELEGRAM_MESSAGE_LENGTH,
  MAX_TELEGRAM_RICH_MESSAGE_LENGTH,
  SAVED_MESSAGES_DESTINATION,
  TELEGRAM_MESSAGE_FORMATS
};
