import path from 'node:path';
import { createBackupService } from './backupService.js';
import { createAuthorizedTelegramClient } from '../telegram/telegramSync.js';

export function attachBackup({ config, store, ...options }) {
  if (store.backup) return store.backup;
  const root = path.resolve(config.backupDir || './data/chat-archive');
  for (const candidate of [config.imageCacheDir, config.audioTranscriptionWorkDir].filter(Boolean)) {
    const directory = path.resolve(candidate);
    for (const [a, b] of [[root, directory], [directory, root]]) {
      const relative = path.relative(a, b);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('BACKUP_DIR must be separate from cache and transcription work directories');
      }
    }
  }
  const backup = createBackupService({ config, store, ...options });
  store.backup = backup;
  store.backupArchive = backup.archive;
  const upsert = store.upsertMessages.bind(store);
  store.upsertMessages = async (messages) => {
    // Capture the previous indexed state before a mutable Mongo upsert.
    const selections = await backup.selected();
    for (const selected of selections) {
      const ids = messages.filter((m) => String(m.sourceId) === selected.sourceId).map((m) => m.messageId);
      if (ids.length) await backup.captureIndexed(await store.getMessagesByIds({ sourceId: selected.sourceId, messageIds: ids }));
    }
    const result = await upsert(messages);
    for (const selected of selections) {
      const ids = messages.filter((m) => String(m.sourceId) === selected.sourceId).map((m) => m.messageId);
      if (ids.length) await backup.captureIndexed(await store.getMessagesByIds({ sourceId: selected.sourceId, messageIds: ids }));
    }
    return result;
  };
  for (const method of ['completeAudioTranscription', 'failAudioTranscription', 'updateMessageReactions']) {
    const original = store[method].bind(store);
    store[method] = async (...args) => {
      const result = await original(...args);
      if (result?.messageId) await backup.captureIndexed([{
        ...result, ...(method === 'completeAudioTranscription' && args[0].media ? { transcriptMedia: args[0].media } : {})
      }]);
      return result;
    };
  }
  return backup;
}

export function startBackupWorker({ backup, config, logger = console, createClient = createAuthorizedTelegramClient }) {
  let stopped = false;
  let timer;
  let task = Promise.resolve();
  let listener = null;
  async function tick() {
    const selections = await backup.selected();
    if (!selections.length) return;
    const statuses = [];
    for (const selected of selections) {
      try { statuses.push(await backup.status(selected.sourceId)); }
      catch (error) { logger.warn(`Chat backup status failed for ${selected.sourceId}: ${error.message}`); }
    }
    const capturing = statuses.some((status) => status.captureEnabled);
    if (capturing && (!listener || listener.connected === false)) {
      try {
        if (listener) await listener.disconnect();
        listener = await createClient(config);
        listener.addEventHandler((update) => backup.handleUpdate(update)
          .catch((error) => logger.warn(`Chat backup update failed: ${error.message}`)));
      } catch (error) { listener = null; logger.warn(`Chat backup listener failed: ${error.message}`); }
    } else if (!capturing && listener) { await listener.disconnect(); listener = null; }
    for (const status of statuses) {
      const sourceId = status.sourceId;
      if (status.captureEnabled && (!status.collection?.retryAt || Date.parse(status.collection.retryAt) <= Date.now())) {
        try { await backup.run(sourceId); }
        catch (error) { logger.warn(`Chat backup collection failed for ${sourceId}: ${error.message}`); }
      }
      if (config.backupReplicaDir && (!status.replication?.at
        || Date.now() - Date.parse(status.replication.at) >= (status.replication.status === 'error' ? 60 : config.backupReplicaIntervalSeconds || 86400) * 1000)) {
        try { await backup.replicate(sourceId); }
        catch (error) { logger.warn(`Chat backup replication failed for ${sourceId}: ${error.message}`); }
      }
    }
  }
  function schedule(delay = (config.backupIntervalSeconds || 60) * 1000) {
    if (stopped) return;
    timer = setTimeout(() => {
      task = tick().catch((error) => logger.warn(`Chat backup failed: ${error.message}`)).finally(() => schedule());
    }, delay);
    timer.unref();
  }
  schedule(0);
  return { async stop() { stopped = true; clearTimeout(timer); backup.requestStop(); await task; if (listener) await listener.disconnect(); await backup.wait(); } };
}
