import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

async function readSession(sessionFile) {
  try {
    return (await fs.readFile(sessionFile, 'utf8')).trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function writeSession(sessionFile, value) {
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, value, { mode: 0o600 });
}

function entityId(entity) {
  const value = entity?.id;
  if (value && typeof value.toString === 'function') {
    return value.toString();
  }
  return String(value);
}

function entityTitle(entity) {
  return entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || entity?.username || entityId(entity);
}

function messageLink(source, messageId) {
  if (source.username) {
    return `https://t.me/${source.username}/${messageId}`;
  }
  return null;
}

export async function createTelegramClient(config, prompts) {
  if (!config.telegramApiId || !config.telegramApiHash) {
    throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required');
  }

  const sessionValue = await readSession(config.telegramSessionFile);
  const session = new StringSession(sessionValue);
  const client = new TelegramClient(
    session,
    Number(config.telegramApiId),
    config.telegramApiHash,
    { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: () => prompts.ask('Telegram phone: '),
    password: () => prompts.ask('Telegram password: '),
    phoneCode: () => prompts.ask('Telegram code: '),
    onError: (error) => console.error(error)
  });

  await writeSession(config.telegramSessionFile, client.session.save());
  return client;
}

export async function listTelegramSources({ client }) {
  const dialogs = await client.getDialogs({});
  return dialogs
    .map((dialog) => {
      const entity = dialog.entity;
      return {
        sourceId: entityId(entity),
        title: entityTitle(entity),
        username: entity?.username || null,
        type: entity?.className || 'unknown',
        enabled: false,
        tags: []
      };
    })
    .filter((source) => source.sourceId && source.title);
}

export async function syncTelegramMessages({ client, store, config }) {
  const allowed = new Set(config.allowedSourceIds);
  if (!allowed.size) {
    throw new Error('ALLOWED_SOURCE_IDS must contain at least one Telegram source id before syncing');
  }

  const sources = (await listTelegramSources({ client }))
    .map((source) => ({
      ...source,
      enabled: allowed.has(source.sourceId)
    }));

  for (const source of sources) {
    await store.upsertSource(source);
  }

  const enabledSources = sources.filter((source) => source.enabled);
  let messageCount = 0;

  for (const source of enabledSources) {
    const messages = [];
    for await (const message of client.iterMessages(source.sourceId, { limit: config.telegramSyncLimit })) {
      if (!message.message) {
        continue;
      }

      messages.push({
        sourceId: source.sourceId,
        sourceTitle: source.title,
        messageId: message.id,
        date: message.date ? new Date(message.date * 1000) : new Date(),
        senderId: message.senderId ? message.senderId.toString() : null,
        senderName: null,
        text: message.message,
        replyToMessageId: message.replyTo?.replyToMsgId || null,
        views: message.views || null,
        link: messageLink(source, message.id),
        entities: message.entities || [],
        raw: {
          groupedId: message.groupedId?.toString?.() || null,
          post: Boolean(message.post)
        }
      });
    }

    await store.upsertMessages(messages);
    messageCount += messages.length;
  }

  return {
    sourceCount: enabledSources.length,
    messageCount
  };
}
