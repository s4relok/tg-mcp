import { createAuthorizedTelegramClient } from './telegramSync.js';

const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;
const SAVED_MESSAGES_DESTINATION = Object.freeze({ type: 'saved' });

function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('text must be a non-empty string');
  }
  if (text.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
    throw new Error(`text must be at most ${MAX_TELEGRAM_MESSAGE_LENGTH} characters`);
  }
  return text;
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
  createClient = createAuthorizedTelegramClient
}) {
  if (typeof createClient !== 'function') {
    throw new Error('createClient is required');
  }

  return {
    async sendMessage({
      text,
      destination = SAVED_MESSAGES_DESTINATION
    } = {}) {
      const messageText = validateText(text);
      const target = validateDestination(destination);
      let client = null;

      try {
        client = await createClient(config);
        const sent = await client.sendMessage('me', {
          message: messageText,
          parseMode: false
        });
        return {
          status: 'sent',
          destination: target,
          messageId: sent.id,
          date: messageDateIso(sent.date)
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
  SAVED_MESSAGES_DESTINATION
};
