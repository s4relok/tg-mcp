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

export function telegramEntityId(entity) {
  const value = entity?.id;
  if (value && typeof value.toString === 'function') {
    return value.toString();
  }
  return String(value);
}

export function telegramEntityTitle(entity) {
  return entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || entity?.username || telegramEntityId(entity);
}

function messageLink(source, messageId) {
  if (source.username) {
    return `https://t.me/${source.username}/${messageId}`;
  }
  return null;
}

function secondsToDate(value) {
  if (!value) {
    return new Date();
  }
  if (value instanceof Date) {
    return value;
  }
  return new Date(value * 1000);
}

export function normalizeTelegramSource(dialog, { allowedSourceIds = [] } = {}) {
  const entity = dialog.entity || dialog;
  const sourceId = telegramEntityId(entity);
  const allowed = new Set(allowedSourceIds.map(String));

  return {
    sourceId,
    title: telegramEntityTitle(entity),
    username: entity?.username || null,
    type: entity?.className || 'unknown',
    enabled: allowed.size > 0 ? allowed.has(sourceId) : false,
    tags: []
  };
}

export function normalizeTelegramMessage(message, source) {
  return {
    sourceId: source.sourceId,
    sourceTitle: source.title,
    messageId: message.id,
    date: secondsToDate(message.date),
    senderId: message.senderId ? message.senderId.toString() : null,
    senderName: null,
    text: message.message || '',
    replyToMessageId: message.replyTo?.replyToMsgId || null,
    views: message.views || null,
    link: messageLink(source, message.id),
    entities: message.entities || [],
    raw: {
      groupedId: message.groupedId?.toString?.() || null,
      post: Boolean(message.post)
    }
  };
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

export async function createAuthorizedTelegramClient(config) {
  if (!config.telegramApiId || !config.telegramApiHash) {
    throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required');
  }

  const sessionValue = await readSession(config.telegramSessionFile);
  if (!sessionValue) {
    throw new Error(`Telegram session file is empty or missing: ${config.telegramSessionFile}`);
  }

  const session = new StringSession(sessionValue);
  const client = new TelegramClient(
    session,
    Number(config.telegramApiId),
    config.telegramApiHash,
    { connectionRetries: 5 }
  );

  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    throw new Error('Telegram session is not authorized. Run npm run cli -- login interactively first.');
  }

  return client;
}

export async function createTelegramLoginReport({ client, config }) {
  const authorized = typeof client.checkAuthorization === 'function'
    ? await client.checkAuthorization()
    : true;

  return {
    status: authorized ? 'ok' : 'error',
    authorized,
    sessionFile: config.telegramSessionFile
  };
}

export async function listTelegramSources({ client, allowedSourceIds = [] }) {
  const dialogs = await client.getDialogs({});
  return dialogs
    .map((dialog) => normalizeTelegramSource(dialog, { allowedSourceIds }))
    .filter((source) => source.sourceId && source.title);
}

async function selectedSourceIds({ store, config, sourceIds = [] }) {
  if (sourceIds.length) {
    return sourceIds.map(String);
  }

  if ((config.allowedSourceIds || []).length) {
    return config.allowedSourceIds.map(String);
  }

  const enabledSources = await store.listSources();
  return enabledSources.map((source) => source.sourceId);
}

export async function refreshTelegramSources({ client, store, config }) {
  const explicitAllowed = (config.allowedSourceIds || []).map(String);
  const sources = await listTelegramSources({
    client,
    allowedSourceIds: explicitAllowed
  });

  for (const source of sources) {
    await store.upsertSource(source, {
      preserveEnabled: explicitAllowed.length === 0,
      preserveTags: true
    });
  }

  return {
    sourceCount: sources.length,
    selectedSourceCount: sources.filter((source) => source.enabled).length,
    sources
  };
}

export async function syncTelegramMessages({ client, store, config, sourceIds, limit, minDate } = {}) {
  const allowed = new Set(await selectedSourceIds({ store, config, sourceIds }));
  if (!allowed.size) {
    throw new Error('No selected Telegram sources. Set ALLOWED_SOURCE_IDS or run refresh-sources and enable-source first.');
  }

  const dbSources = await store.listSources({ includeDisabled: true, sourceIds: [...allowed] });
  const dbSourceById = new Map(dbSources.map((source) => [source.sourceId, source]));
  const sources = await listTelegramSources({ client, allowedSourceIds: [...allowed] });

  for (const source of sources) {
    await store.upsertSource(source, { preserveTags: true });
  }

  const enabledSources = sources.filter((source) => source.enabled);
  let messageCount = 0;
  const perSource = [];

  for (const source of enabledSources) {
    const messages = [];
    const iterOptions = { limit: limit || config.telegramSyncLimit };
    const dbSource = dbSourceById.get(source.sourceId);
    const lastSyncedMessageId = Number(dbSource?.lastSyncedMessageId || 0);
    if (!minDate && lastSyncedMessageId > 0) {
      iterOptions.minId = lastSyncedMessageId;
    }

    for await (const message of client.iterMessages(source.sourceId, iterOptions)) {
      if (!message.message) {
        continue;
      }

      const normalized = normalizeTelegramMessage(message, source);
      if (minDate && normalized.date < minDate) {
        continue;
      }

      messages.push(normalized);
    }

    await store.upsertMessages(messages);
    const maxMessageId = messages.reduce(
      (max, message) => Math.max(max, message.messageId),
      lastSyncedMessageId || 0
    );
    await store.markSourceSynced?.(source.sourceId, {
      lastSyncedMessageId: maxMessageId || null,
      messageCount: messages.length
    });
    messageCount += messages.length;
    perSource.push({
      sourceId: source.sourceId,
      title: source.title,
      messageCount: messages.length,
      lastSyncedMessageId: maxMessageId || null,
      incremental: Boolean(iterOptions.minId)
    });
  }

  return {
    sourceCount: enabledSources.length,
    messageCount,
    sources: perSource
  };
}
