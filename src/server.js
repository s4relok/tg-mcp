import { assertSafeRuntimeConfig, loadConfigFromProcessEnv } from './config.js';
import { createApp } from './app.js';
import { createTelegramDigestService } from './services/digestService.js';
import { createMongoStore } from './storage/mongoStore.js';
import { startAudioTranscriptionWorker } from './audio/transcriptionWorker.js';
import { startTelegramSyncWorker } from './telegram/syncWorker.js';
import { startTelegramSlashBot } from './telegram/slashBot.js';

async function main() {
  const config = loadConfigFromProcessEnv();
  assertSafeRuntimeConfig(config);
  const store = await createMongoStore(config);
  const digestService = createTelegramDigestService(store);
  const app = createApp({ config, store, digestService });
  const audioTranscriptionWorker = startAudioTranscriptionWorker({ config, store });
  const syncWorker = startTelegramSyncWorker({
    config,
    store,
    afterSync: async () => {
      await audioTranscriptionWorker.runOnce({
        limit: config.audioTranscriptionBatchSize
      });
    }
  });
  const slashBot = startTelegramSlashBot({ config, digestService });

  const server = app.listen(config.port, config.host, () => {
    console.log(`tg-mcp listening on http://${config.host}:${config.port}${config.mcpPath}`);
  });

  async function shutdown(signal) {
    console.log(`Received ${signal}; shutting down.`);
    server.close(async () => {
      await syncWorker.stop();
      await audioTranscriptionWorker.stop();
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
