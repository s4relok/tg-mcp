import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArchiveStore, canonical, exactSourceId, hash, fileHash } from './archiveStore.js';
import { exportSnapshot, restoreSnapshot } from './snapshots.js';
import { archiveMedia, downloadArchiveMedia, mediaKey, normalizeArchiveMessage } from './telegramBackup.js';
import { createAuthorizedTelegramClient, telegramPeerId, normalizeTelegramReactions } from '../telegram/telegramSync.js';
import { resolveTelegramSourceEntity } from '../audio/telegramAudio.js';
import { createOpenAiAudioTranscriber } from '../audio/openAiTranscriber.js';
import { mcpAudioExtension } from '../audio/telegramAudio.js';

function integer(value, fallback, max) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error(`Expected integer between 1 and ${max}`);
  return result;
}

function transcriptPayload(message) {
  const transcription = { ...(message.transcription || {}) };
  for (const key of ['lockUntil', 'updatedAt', 'nextAttemptAt']) delete transcription[key];
  return { transcriptText: message.transcriptText || '', transcription };
}

export function createBackupService({ config, store, archive = new ArchiveStore(config.backupDir || './data/chat-archive', { minFreeBytes: config.backupMinFreeBytes }),
  createClient = createAuthorizedTelegramClient, downloadMedia = downloadArchiveMedia,
  createTranscriber = createOpenAiAudioTranscriber, logger = console }) {
  let running = null;
  let stopping = false;

  function checkId(sourceId) {
    const id = exactSourceId(sourceId);
    if (config.allowedSourceIds?.length && !config.allowedSourceIds.includes(id)) throw new Error('Backup source is outside ALLOWED_SOURCE_IDS');
    return id;
  }
  async function access(sourceId) { return archive.assertSelected(checkId(sourceId)); }

  async function activeSource(sourceId) {
    const [source] = await store.listSources({ sourceIds: [checkId(sourceId)] });
    if (!source) throw new Error('Backup collection requires an enabled source');
    return source;
  }

  async function captureIndexed(messages) {
    for (const selected of await archive.selections()) {
      const scoped = messages.filter((item) => String(item.sourceId) === selected.sourceId);
      if (scoped.length) await captureIndexedSource(selected, scoped);
    }
  }

  async function captureIndexedSource(selected, messages) {
    const state = await archive.view(selected.sourceId);
    if (!state.latest.get('control:capture')?.payload.enabled) return;
    const entries = [];
    for (const message of messages.filter((item) => String(item.sourceId) === selected.sourceId)) {
      checkId(message.sourceId);
      const plain = JSON.parse(canonical(message));
      for (const key of ['_id', 'updatedAt', 'createdAt']) delete plain[key];
      const oldIndex = state.latest.get(`indexed:${message.messageId}`)?.payload;
      const transcriptOrigin = message.transcriptMedia ? mediaKey(message.transcriptMedia)
        : oldIndex && message.transcriptText && message.transcriptText === oldIndex.transcriptText
          ? oldIndex.transcriptMediaKey || mediaKey(oldIndex.media) : mediaKey(message.media);
      plain.transcriptMediaKey = transcriptOrigin;
      delete plain.transcriptMedia;
      // Preserve the operational index independently of authoritative Telegram
      // versions. A filtered sync must never replace a richer archive message.
      entries.push({ kind: 'indexed', key: String(message.messageId), payload: plain });
      if (message.media) {
        const key = `${message.messageId}:${mediaKey(message.media)}`;
        if (!state.latest.has(`media:${key}`)) entries.push({ kind: 'media', key, ifAbsent: true,
          payload: { messageId: message.messageId, media: message.media, status: 'pending', attempts: 0 } });
      }
      if ((message.transcriptText || message.transcription)
        && (!oldIndex || canonical(transcriptPayload(oldIndex)) !== canonical(transcriptPayload(message)))) entries.push({
        kind: 'transcript', key: `${message.messageId}:${transcriptOrigin || 'unknown'}`,
        payload: { ...transcriptPayload(message), media: message.transcriptMedia || (transcriptOrigin === mediaKey(message.media) ? message.media : oldIndex?.media) || null }
      });
    }
    await archive.append(selected.sourceId, entries);
  }

  async function seed(sourceId) {
    // Streaming traversal, including already deleted Telegram messages.
    let batch = [];
    for await (const message of store.iterateBackupMessages(sourceId)) {
      batch.push(message);
      if (batch.length >= 200) { await captureIndexed(batch); await seedCache(sourceId, batch); batch = []; }
    }
    await captureIndexed(batch);
    await seedCache(sourceId, batch);
    const supplemental = await store.getBackupSupplemental(sourceId);
    await archive.append(sourceId, supplemental.map((payload) => ({ kind: 'supplemental', key: hash(canonical(payload)), payload })));
  }

  async function seedCache(sourceId, messages) {
    if (!config.imageCacheDir || !store.getMediaCacheEntries || !messages.length) return;
    const entries = await store.getMediaCacheEntries({ sourceId, messageIds: messages.map((m) => m.messageId) });
    const state = await archive.view(sourceId);
    for (const entry of entries) {
      const message = messages.find((m) => m.messageId === entry.messageId);
      const key = `${entry.messageId}:${mediaKey(message?.media)}`;
      if (state.latest.has(`cached_media:${key}`) || state.latest.get(`media:${key}`)?.payload.status === 'saved') continue;
      try {
        const root = await fs.realpath(config.imageCacheDir);
        const source = await fs.realpath(path.resolve(root, entry.relativePath));
        const relative = path.relative(root, source);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        if ((await fs.stat(source)).size !== entry.size || await fileHash(source) !== entry.sha256) continue;
        const work = path.join(archive.sourceRoot(sourceId), 'work');
        await fs.mkdir(work, { recursive: true, mode: 0o700 });
        const copy = path.join(work, `${randomUUID()}.partial`);
        try {
          await fs.copyFile(source, copy);
          const blob = await archive.saveBlob(sourceId, copy);
          if (blob.sha256 !== entry.sha256) throw new Error('Image cache changed while being archived');
          // Old cache metadata does not identify photo variant or Telegram file
          // version. Retain these bytes, but never claim they are an original.
          await archive.append(sourceId, [{ kind: 'cached_media', key, ifAbsent: true, payload: {
            messageId: entry.messageId, media: message?.media || { mimeType: entry.mimeType },
            ...blob, status: 'saved', original: false, provenance: 'legacy_image_cache_unverified_version'
          } }]);
        } finally { await fs.rm(copy, { force: true }); }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async function enable(sourceId) {
    const source = await activeSource(sourceId);
    await archive.select(source.sourceId);
    await archive.append(source.sourceId, [
      { kind: 'source', key: 'metadata', payload: source },
      { kind: 'control', key: 'capture', payload: { enabled: true } }
    ]);
    await seed(source.sourceId);
    return status(source.sourceId);
  }

  async function pause(sourceId) {
    const id = await access(sourceId);
    await archive.append(id, [{ kind: 'control', key: 'capture', payload: { enabled: false } }]);
    return status(id);
  }

  async function captureTelegram(sourceId, source, messages) {
    const entries = [];
    const state = await archive.view(sourceId);
    for (const message of messages) {
      if (!Number.isInteger(message.id) || message.id < 1 || message.className === 'MessageEmpty') continue;
      const normalized = normalizeArchiveMessage(message, source);
      entries.push({ kind: 'message', key: String(message.id), payload: normalized });
      if (normalized.media) {
        const key = `${message.id}:${normalized.mediaKey}`;
        if (!state.latest.has(`media:${key}`)) entries.push({
          kind: 'media', key, ifAbsent: true, payload: { messageId: message.id, media: normalized.media,
            status: normalized.media.kind === 'unsupported' ? 'unsupported' : 'pending', attempts: 0 }
        });
      }
    }
    await archive.append(sourceId, entries);
  }

  async function processMedia(sourceId, client, entity, limit) {
    const state = await archive.view(sourceId);
    const jobs = [...state.latest.values()].filter((record) => record.kind === 'media'
      && ['pending', 'failed', 'blocked_by_limit'].includes(record.payload.status)
      && (!record.payload.retryAt || Date.parse(record.payload.retryAt) <= Date.now()))
      .sort((a, b) => b.payload.messageId - a.payload.messageId).slice(0, limit);
    for (const job of jobs) {
      if (stopping) return;
      const current = await archive.view(sourceId);
      if (!current.latest.get('control:capture')?.payload.enabled) return;
      await activeSource(sourceId);
      const payload = { ...job.payload, attempts: (job.payload.attempts || 0) + 1 };
      try {
        const [message] = await client.getMessages(entity, { ids: [payload.messageId] });
        if (!message || message.className === 'MessageEmpty') throw Object.assign(new Error('Message is no longer available'), { code: 'unavailable' });
        if (mediaKey(archiveMedia(message)) !== job.key.split(':')[1]) throw Object.assign(new Error('Original attachment was replaced before download'), { code: 'unavailable' });
        payload.media = archiveMedia(message);
        const blob = await downloadMedia({ client, message, media: payload.media, archive, sourceId,
          maxFileBytes: config.backupMaxFileBytes || 2 * 1024 ** 3 });
        await archive.append(sourceId, [{ kind: 'media', key: job.key,
          payload: { ...payload, ...blob, status: 'saved', retryAt: null, error: null } }]);
      } catch (error) {
        if (['ENOSPC', 'EIO', 'EROFS', 'EACCES'].includes(error.code)) throw error;
        const seconds = Math.max(Number(error.seconds) || 0, Math.min(86400, 60 * 2 ** Math.min(payload.attempts, 10)));
        await archive.append(sourceId, [{ kind: 'media', key: job.key, payload: {
          ...payload, status: ['unavailable', 'unsupported', 'blocked_by_limit'].includes(error.code) ? error.code : 'failed',
          error: String(error.message).slice(0, 300), retryAt: new Date(Date.now() + seconds * 1000).toISOString()
        } }]);
        if (Number(error.seconds) > 0) throw error;
      }
    }
  }

  async function collect(sourceId, { pages = 5 } = {}) {
    const id = await access(sourceId);
    const source = await activeSource(id);
    pages = integer(pages, 5, 100);
    const state = await archive.view(id);
    if (!state.latest.get('control:capture')?.payload.enabled) return { status: 'paused', sourceId: id };
    const owner = `backup:${randomUUID()}`;
    const claimed = await store.claimSourceSync(id, { now: new Date(), lockUntil: new Date(Date.now() + 120000), owner });
    if (!claimed) return { status: 'busy', sourceId: id };
    let lostLease = false;
    const heartbeat = setInterval(() => {
      store.renewBackupLease(id, owner, new Date(Date.now() + 120000)).then((ok) => { if (!ok) lostLease = true; })
        .catch(() => { lostLease = true; });
    }, 20000);
    heartbeat.unref();
    let client;
    const assertLease = () => { if (lostLease) throw new Error('Backup collection lost its source lease'); };
    try {
      await seed(id);
      client = await createClient(config);
      const entity = await resolveTelegramSourceEntity({ client, sourceId: id });
      const pageSize = config.backupPageSize || 100;
      const cursor = { ...(state.latest.get('cursor:history')?.payload || { latest: 0, before: 0, complete: false, reconcileBefore: 0 }) };
      if (!state.latest.has('cursor:history')) {
        const newest = await client.getMessages(entity, { limit: 1 });
        await captureTelegram(id, source, newest);
        cursor.latest = newest[0]?.id || 0;
        await archive.append(id, [{ kind: 'cursor', key: 'history', payload: cursor }]);
      }
      // Oldest-to-newest incremental pages never jump over a backlog.
      for (let page = 0; page < pages; page++) {
        if (stopping) break;
        assertLease();
        if (!(await archive.view(id)).latest.get('control:capture')?.payload.enabled) break;
        await activeSource(id);
        const messages = [];
        for await (const message of client.iterMessages(entity, { minId: cursor.latest, reverse: true, limit: pageSize })) messages.push(message);
        await captureTelegram(id, source, messages);
        if (messages.length) cursor.latest = Math.max(cursor.latest, ...messages.map((m) => m.id));
        await archive.append(id, [{ kind: 'cursor', key: 'history', payload: cursor }]);
        if (messages.length < pageSize) break;
      }
      await processMedia(id, client, entity, config.backupMediaBatchSize || 20);
      // An independent backward cursor imports or reconciles the whole history.
      for (let page = 0; page < pages; page++) {
        if (stopping) break;
        assertLease();
        if (!(await archive.view(id)).latest.get('control:capture')?.payload.enabled) break;
        await activeSource(id);
        const before = cursor.complete ? cursor.reconcileBefore : cursor.before;
        const messages = [];
        for await (const message of client.iterMessages(entity, { offsetId: before || 0, limit: pageSize })) messages.push(message);
        await captureTelegram(id, source, messages);
        const next = messages.length ? Math.min(...messages.map((m) => m.id)) : 0;
        if (cursor.complete) cursor.reconcileBefore = messages.length < pageSize ? 0 : next;
        else { cursor.before = next; cursor.complete = messages.length < pageSize; }
        await archive.append(id, [{ kind: 'cursor', key: 'history', payload: cursor }]);
        if (messages.length < pageSize) break;
      }
      await processMedia(id, client, entity, config.backupMediaBatchSize || 20);
      assertLease();
      await archive.append(id, [{ kind: 'health', key: 'collection', payload: { status: 'ok', lastSuccessAt: new Date().toISOString() } }]);
    } catch (error) {
      await archive.append(id, [{ kind: 'health', key: 'collection', payload: {
        status: 'error', error: String(error.message).slice(0, 300), at: new Date().toISOString(),
        retryAt: new Date(Date.now() + Math.max(Number(error.seconds) || 0, 60) * 1000).toISOString()
      } }]);
      throw error;
    } finally {
      clearInterval(heartbeat);
      try { if (client) await client.disconnect(); }
      finally { await store.releaseBackupLease(id, owner); }
    }
    return status(id);
  }

  async function run(sourceId, options) {
    if (stopping) return { status: 'stopping', sourceId: checkId(sourceId) };
    if (running) return { status: 'busy', sourceId: checkId(sourceId) };
    running = collect(sourceId, options);
    try { return await running; } finally { running = null; }
  }

  async function status(sourceId) {
    const id = await access(sourceId);
    const state = await archive.view(id);
    const values = [...state.latest.values()];
    const media = {};
    let bytes = 0;
    for (const record of values.filter((r) => r.kind === 'media')) {
      media[record.payload.status] = (media[record.payload.status] || 0) + 1;
      if (record.payload.status === 'saved') bytes += record.payload.size;
    }
    const messages = new Set(values.filter((r) => ['message', 'indexed'].includes(r.kind)).map((r) => r.key));
    const space = await fs.statfs(archive.root);
    return {
      sourceId: id, localArchive: archive.sourceRoot(id), captureEnabled: values.find((r) => r.kind === 'control' && r.key === 'capture')?.payload.enabled || false,
      history: state.latest.get('cursor:history')?.payload || { complete: false },
      messages: messages.size, messageVersions: state.records.filter((r) => r.kind === 'message').length,
      transcripts: values.filter((r) => r.kind === 'transcript' && r.payload.transcriptText).length,
      media, mediaBytes: bytes, freeBytes: Number(space.bavail) * Number(space.bsize),
      cachedMediaCopies: values.filter((r) => r.kind === 'cached_media').length,
      knownMediaComplete: Object.entries(media).every(([key, count]) => key === 'saved' || count === 0),
      mediaGaps: values.filter((r) => r.kind === 'media' && !['saved', 'pending'].includes(r.payload.status))
        .slice(0, 20).map((r) => ({ messageId: r.payload.messageId, status: r.payload.status, error: r.payload.error || null })),
      collection: state.latest.get('health:collection')?.payload || null,
      replication: state.latest.get('health:replication')?.payload || { status: config.backupReplicaDir ? 'pending' : 'not_configured' },
      verification: state.latest.get('health:verification')?.payload || null,
      records: state.seq
    };
  }

  function messagesFrom(state) {
    const messages = new Map();
    for (const r of state.latest.values()) if (r.kind === 'indexed') messages.set(r.key, { ...r.payload });
    for (const r of state.latest.values()) if (r.kind === 'message') messages.set(r.key, { ...messages.get(r.key), ...r.payload, transcriptText: '' });
    for (const r of state.latest.values()) if (r.kind === 'transcript') {
      const [id, fingerprint] = r.key.split(':');
      const message = messages.get(id);
      if (message && (fingerprint === mediaKey(message.media) || !message.media)) Object.assign(message, r.payload);
    }
    for (const r of state.latest.values()) if (r.kind === 'deleted' && messages.has(r.key)) messages.get(r.key).deletedInTelegram = r.payload;
    for (const r of state.latest.values()) if (r.kind === 'reactions' && messages.has(r.key)) Object.assign(messages.get(r.key), r.payload);
    return [...messages.values()].sort((a, b) => a.messageId - b.messageId);
  }

  async function search({ sourceId, query = '', limit = 50, beforeMessageId } = {}) {
    const id = await access(sourceId);
    limit = integer(limit, 50, 200);
    if (typeof query !== 'string' || query.length > 2000) throw new Error('Invalid backup search query');
    if (beforeMessageId !== undefined) integer(beforeMessageId, 1, Number.MAX_SAFE_INTEGER);
    const state = await archive.view(id);
    const needle = query.toLocaleLowerCase();
    const messages = messagesFrom(state).reverse().filter((m) => (!beforeMessageId || m.messageId < beforeMessageId)
      && [m.text, m.transcriptText, m.senderName].some((text) => String(text || '').toLocaleLowerCase().includes(needle)))
      .slice(0, limit).map(({ telegram, ...message }) => message);
    return { sourceId: id, messages, nextBeforeMessageId: messages.length === limit ? messages.at(-1).messageId : null };
  }

  async function context({ sourceId, messageId, before = 5, after = 5 }) {
    const id = await access(sourceId);
    integer(messageId, 1, Number.MAX_SAFE_INTEGER);
    if (![before, after].every((v) => Number.isInteger(v) && v >= 0 && v <= 50)) throw new Error('Context limits must be 0..50');
    const state = await archive.view(id);
    const all = messagesFrom(state);
    const index = all.findIndex((m) => m.messageId === messageId);
    return { sourceId: id, messages: index < 0 ? [] : all.slice(Math.max(0, index - before), index + after + 1),
      versions: state.records.filter((r) => ['message', 'indexed', 'transcript', 'media', 'deleted'].includes(r.kind)
        && (r.key === String(messageId) || r.key.startsWith(`${messageId}:`))).map(({ file, digest, ...r }) => r) };
  }

  async function mediaFile({ sourceId, messageId, version }) {
    const id = await access(sourceId);
    integer(messageId, 1, Number.MAX_SAFE_INTEGER);
    const state = await archive.view(id);
    const message = state.latest.get(`message:${messageId}`)?.payload || state.latest.get(`indexed:${messageId}`)?.payload;
    const fingerprint = version || message?.mediaKey || mediaKey(message?.media);
    let media = state.latest.get(`media:${messageId}:${fingerprint}`)?.payload;
    if (media?.status !== 'saved') media = state.latest.get(`cached_media:${messageId}:${fingerprint}`)?.payload;
    if (!media || media.status !== 'saved') throw new Error('Original is not archived for this message/version');
    const filePath = archive.blobPath(id, media.sha256);
    if (await fileHash(filePath) !== media.sha256) throw new Error('Archived media checksum mismatch');
    return { sourceId: id, messageId, original: true, ...media, filePath };
  }

  async function verify(sourceId) {
    const id = await access(sourceId);
    const result = await archive.verify(id);
    await archive.append(id, [{ kind: 'health', key: 'verification', payload: { ...result, at: new Date().toISOString() } }]);
    return result;
  }

  async function replicate(sourceId, destination = config.backupReplicaDir) {
    const id = await access(sourceId);
    if (!destination) throw new Error('BACKUP_REPLICA_DIR is not configured');
    try {
      const result = await exportSnapshot(archive, id, destination);
      await archive.append(id, [{ kind: 'health', key: 'replication', payload: { ...result, at: new Date().toISOString() } }]);
      return result;
    } catch (error) {
      await archive.append(id, [{ kind: 'health', key: 'replication', payload: { status: 'error', error: error.message, at: new Date().toISOString() } }]);
      throw error;
    }
  }

  async function transcribe({ sourceId, limit = 1 }) {
    const id = await access(sourceId);
    limit = integer(limit, 1, 20);
    const state = await archive.view(id);
    const jobs = [...state.latest.values()].filter((r) => r.kind === 'media' && r.payload.status === 'saved'
      && ['voice', 'audio'].includes(r.payload.media.kind) && !state.latest.get(`transcript:${r.key}`)?.payload.transcriptText).slice(0, limit);
    const transcriber = createTranscriber(config);
    const results = [];
    for (const job of jobs) {
      const item = await mediaFile({ sourceId: id, messageId: job.payload.messageId, version: job.key.split(':')[1] });
      const work = path.join(archive.sourceRoot(id), 'work');
      await fs.mkdir(work, { recursive: true, mode: 0o700 });
      const temporary = path.join(work, `${randomUUID()}${mcpAudioExtension(item.media.mimeType)}`);
      let result;
      try {
        await fs.copyFile(item.filePath, temporary);
        result = await transcriber.transcribe(temporary, { durationSec: item.media.durationSec || null });
      } finally { await fs.rm(temporary, { force: true }); }
      if (!result.text?.trim()) throw new Error('Empty transcription result');
      await archive.append(id, [{ kind: 'transcript', key: job.key, payload: {
        transcriptText: result.text.trim(), media: item.media,
        transcription: { status: 'done', ...result, completedAt: new Date().toISOString() }
      } }]);
      results.push({ messageId: item.messageId, status: 'done' });
    }
    return { sourceId: id, results };
  }

  async function handleUpdate(update) {
    let shortMessage;
    if (['UpdateShortMessage', 'UpdateShortChatMessage'].includes(update.className)) {
      shortMessage = { ...update, message: update.message, peerId: update.chatId ? { chatId: update.chatId } : { userId: update.userId } };
    }
    const peerId = telegramPeerId(shortMessage?.peerId || update.message?.peerId || update.peer) || (update.channelId ? String(update.channelId) : null);
    if (!peerId) return;
    const selected = await archive.selected(peerId);
    if (!selected) return;
    const id = checkId(selected.sourceId);
    const state = await archive.view(id);
    if (!state.latest.get('control:capture')?.payload.enabled) return;
    const [source] = await store.listSources({ sourceIds: [id] });
    if (!source) return;
    const name = update.className || '';
    if (shortMessage) {
      await captureTelegram(id, source, [shortMessage]);
    } else if (name === 'UpdateMessageReactions' && Number.isInteger(update.msgId)) {
      const reactions = normalizeTelegramReactions(update.reactions);
      await archive.append(id, [{ kind: 'reactions', key: String(update.msgId), payload: {
        reactions, reactionCount: reactions.reduce((sum, reaction) => sum + reaction.count, 0)
      } }]);
    } else if (['UpdateNewMessage', 'UpdateNewChannelMessage', 'UpdateEditMessage', 'UpdateEditChannelMessage'].includes(name)) {
      if (telegramPeerId(update.message?.peerId) === id) await captureTelegram(id, source, [update.message]);
    } else if (name === 'UpdateDeleteChannelMessages' && String(update.channelId) === id) {
      await archive.append(id, (update.messages || []).map((messageId) => ({ kind: 'deleted', key: String(messageId), payload: { confirmed: true } })));
    }
    // Non-channel deletion updates do not identify a peer: deliberately do not
    // guess a chat from a message id that may collide with channel ids.
  }

  async function saveDownloaded(job, filePath) {
    const selected = await archive.selected(job.sourceId);
    if (!selected || selected.sourceId !== String(job.sourceId)) return;
    const state = await archive.view(selected.sourceId);
    if (!state.latest.get('control:capture')?.payload.enabled) return;
    await captureIndexed([job]);
    const work = path.join(archive.sourceRoot(selected.sourceId), 'work');
    await fs.mkdir(work, { recursive: true, mode: 0o700 });
    const copy = path.join(work, `${randomUUID()}.partial`);
    try {
      await fs.copyFile(filePath, copy);
      const blob = await archive.saveBlob(selected.sourceId, copy);
      await archive.append(selected.sourceId, [{ kind: 'media', key: `${job.messageId}:${mediaKey(job.media)}`,
        payload: { messageId: job.messageId, media: job.media, status: 'saved', ...blob } }]);
    } finally { await fs.rm(copy, { force: true }); }
  }

  return { archive, enable, pause, run, status, search, context, mediaFile, verify, replicate, transcribe,
    captureIndexed, saveDownloaded, handleUpdate, restore: restoreSnapshot, selected: () => archive.selections(),
    requestStop: () => { stopping = true; }, wait: () => running || Promise.resolve(), logger };
}
