import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { effectiveSourceSettings } from '../services/sourceManagement.js';

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

function toStringId(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value.toString === 'function') {
    return value.toString();
  }
  return String(value);
}

function toNumberOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function telegramClassName(value) {
  return value?.className || value?.constructor?.name || '';
}

function documentAttribute(document, expectedClassName) {
  return (document?.attributes || []).find((attribute) => telegramClassName(attribute) === expectedClassName) || null;
}

function telegramDocumentFileName(document) {
  const fileNameAttribute = documentAttribute(document, 'DocumentAttributeFilename');
  return fileNameAttribute?.fileName || fileNameAttribute?.file_name || null;
}

function telegramAudioAttribute(document) {
  return documentAttribute(document, 'DocumentAttributeAudio');
}

export function normalizeTelegramMedia(message) {
  const voiceDocument = message.voice || null;
  const audioDocument = message.audio || null;
  const document = voiceDocument || audioDocument;
  if (!document) {
    return null;
  }

  const audioAttribute = telegramAudioAttribute(document);
  const fileName = telegramDocumentFileName(document);

  return {
    kind: voiceDocument ? 'voice' : 'audio',
    mimeType: document.mimeType || document.mime_type || null,
    size: toNumberOrNull(document.size),
    durationSec: toNumberOrNull(audioAttribute?.duration),
    fileName,
    title: audioAttribute?.title || null,
    performer: audioAttribute?.performer || null,
    documentId: toStringId(document.id),
    dcId: toNumberOrNull(document.dcId || document.dc_id)
  };
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
  const media = normalizeTelegramMedia(message);
  const normalized = {
    sourceId: source.sourceId,
    sourceTitle: source.title,
    messageId: message.id,
    date: secondsToDate(message.date),
    senderId: message.senderId ? message.senderId.toString() : null,
    senderName: null,
    text: message.message || '',
    transcriptText: '',
    replyToMessageId: message.replyTo?.replyToMsgId || null,
    views: message.views || null,
    link: messageLink(source, message.id),
    entities: message.entities || [],
    raw: {
      groupedId: message.groupedId?.toString?.() || null,
      post: Boolean(message.post),
      forwarded: Boolean(message.fwdFrom || message.forward || message.forwardInfo),
      forwardedFromId: toStringId(
        message.fwdFrom?.fromId || message.forward?.fromId || message.forwardInfo?.fromId
      )
    }
  };

  if (media) {
    normalized.media = media;
    normalized.transcription = {
      status: 'pending',
      attempts: 0
    };
  }

  return normalized;
}

function isForwardedMessage(message) {
  return Boolean(message.fwdFrom || message.forward || message.forwardInfo);
}

function hasSyncableMessageContent(message, settings) {
  if (!settings.includeReplies && message.replyTo?.replyToMsgId) {
    return false;
  }
  if (!settings.includeForwardedPosts && isForwardedMessage(message)) {
    return false;
  }
  return Boolean(message.message || (settings.includeMedia && normalizeTelegramMedia(message)));
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

async function selectedSources({ store, config, sourceIds = [] }) {
  const requestedIds = [...new Set((sourceIds || []).map(String))];
  const enabledSources = await store.listSources({
    ...(requestedIds.length ? { sourceIds: requestedIds } : {})
  });
  const ceiling = new Set((config.allowedSourceIds || []).map(String));
  return ceiling.size
    ? enabledSources.filter((source) => ceiling.has(source.sourceId))
    : enabledSources;
}

export async function refreshTelegramSources({ client, store, config }) {
  const explicitAllowed = (config.allowedSourceIds || []).map(String);
  const sources = await listTelegramSources({
    client,
    allowedSourceIds: explicitAllowed
  });

  for (const source of sources) {
    await store.upsertSource(source, {
      preserveEnabled: true,
      preserveTags: true
    });
  }

  const storedSources = await store.listSources({
    includeDisabled: true,
    sourceIds: sources.map((source) => source.sourceId)
  });

  return {
    sourceCount: storedSources.length,
    selectedSourceCount: storedSources.filter((source) => source.enabled).length,
    sources: storedSources
  };
}

export async function syncTelegramMessages({
  client,
  store,
  config,
  sourceIds,
  limit,
  minDate,
  now = new Date()
} = {}) {
  const selected = await selectedSources({ store, config, sourceIds });
  if (!selected.length) {
    throw new Error('No enabled Telegram sources are eligible for sync. Enable a source and check ALLOWED_SOURCE_IDS.');
  }

  const allowed = new Set(selected.map((source) => source.sourceId));
  const dbSourceById = new Map(selected.map((source) => [source.sourceId, source]));
  const sources = (await listTelegramSources({ client, allowedSourceIds: [...allowed] }))
    .filter((source) => source.enabled);

  for (const source of sources) {
    await store.upsertSource(source, { preserveEnabled: true, preserveTags: true });
  }

  let messageCount = 0;
  let audioMessageCount = 0;
  const perSource = [];

  for (const source of sources) {
    const messages = [];
    const dbSource = dbSourceById.get(source.sourceId);
    const { settings } = effectiveSourceSettings(dbSource, config);
    const requestedLimit = limit || config.telegramSyncLimit;
    const effectiveLimit = Math.min(requestedLimit, config.telegramSyncMaxLimit || 1000);
    const iterOptions = { limit: effectiveLimit };
    const lastSyncedMessageId = Number(dbSource?.lastSyncedMessageId || 0);
    if (!minDate && lastSyncedMessageId > 0) {
      iterOptions.minId = lastSyncedMessageId;
    }

    const historyMinDate = new Date(
      now.getTime() - settings.historyDepthDays * 24 * 60 * 60 * 1000
    );
    const effectiveMinDate = minDate && minDate > historyMinDate ? minDate : historyMinDate;

    for await (const message of client.iterMessages(source.sourceId, iterOptions)) {
      if (!hasSyncableMessageContent(message, settings)) {
        continue;
      }

      const normalized = normalizeTelegramMessage(message, source);
      if (normalized.date < effectiveMinDate) {
        continue;
      }

      if (!settings.includeMedia) {
        delete normalized.media;
        delete normalized.transcription;
      }

      messages.push(normalized);
    }

    const sourceAudioMessageCount = messages.filter(
      (message) => message.media?.kind === 'audio' || message.media?.kind === 'voice'
    ).length;
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
    audioMessageCount += sourceAudioMessageCount;
    perSource.push({
      sourceId: source.sourceId,
      title: source.title,
      messageCount: messages.length,
      audioMessageCount: sourceAudioMessageCount,
      lastSyncedMessageId: maxMessageId || null,
      incremental: Boolean(iterOptions.minId)
    });
  }

  return {
    sourceCount: sources.length,
    messageCount,
    audioMessageCount,
    sources: perSource
  };
}
