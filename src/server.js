import { assertSafeRuntimeConfig, loadConfigFromProcessEnv } from './config.js';
import { createApp } from './app.js';
import { createTelegramDigestService } from './services/digestService.js';
import { createSourceManagementService } from './services/sourceManagement.js';
import { createImageCache, startImageCacheJanitor } from './images/imageCache.js';
import { createTelegramImageService } from './images/imageService.js';
import { createMongoStore } from './storage/mongoStore.js';
import { startAudioTranscriptionWorker } from './audio/transcriptionWorker.js';
import { createTelegramSyncCoordinator } from './telegram/sourceSyncCoordinator.js';
import { createTelegramMessageSender } from './telegram/messageSender.js';
import { startTelegramSyncWorker } from './telegram/syncWorker.js';
import { startTelegramReactionWorker } from './telegram/reactionWorker.js';
import { startTelegramSlashBot } from './telegram/slashBot.js';

async function main() {
  const config = loadConfigFromProcessEnv();
  assertSafeRuntimeConfig(config);
  const store = await createMongoStore(config);
  const digestService = createTelegramDigestService(store);
  const sourceManagementService = createSourceManagementService({ store, config });
  const messageSender = createTelegramMessageSender({ config });
  const audioTranscriptionWorker = startAudioTranscriptionWorker({ config, store });
  const imageCache = createImageCache({ config, store });
  const imageService = createTelegramImageService({
    config,
    store,
    cache: imageCache
  });
  const imageCacheJanitor = startImageCacheJanitor({
    cache: imageCache,
    config
  });
  const syncCoordinator = createTelegramSyncCoordinator({
    config,
    store,
    imageService,
    afterSync: async () => {
      await audioTranscriptionWorker.runOnce({
        limit: config.audioTranscriptionBatchSize
      });
    }
  });
  const app = createApp({
    config,
    store,
    digestService,
    sourceManagementService,
    imageService,
    messageSender,
    syncCoordinator,
    audioTranscriptionAdmin: {
      runOnce: audioTranscriptionWorker.runOnce
    }
  });
  const syncWorker = startTelegramSyncWorker({
    config,
    store,
    coordinator: syncCoordinator
  });
  const reactionWorker = startTelegramReactionWorker({ config, store });
  const slashBot = startTelegramSlashBot({ config, digestService });

  const server = app.listen(config.port, config.host, () => {
    console.log(`tg-mcp listening on http://${config.host}:${config.port}${config.mcpPath}`);
    if (config.oauthEnabled) {
      console.log(`OAuth MCP enabled at ${config.oauthResource}`);
    }
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    server.closeIdleConnections?.();
    const forceCloseTimer = setTimeout(() => {
      console.warn('Forcing remaining MCP/HTTP connections closed during shutdown.');
      server.closeAllConnections?.();
    }, 1000);
    forceCloseTimer.unref();
    server.close(async () => {
      clearTimeout(forceCloseTimer);
      await syncWorker.stop();
      await reactionWorker.stop();
      await audioTranscriptionWorker.stop();
      await imageCacheJanitor.stop();
      await slashBot.stop();
      await store.close();
      process.exit(0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
