import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createTelegramDigestService } from './services/digestService.js';
import { createMongoStore } from './storage/mongoStore.js';
import { startTelegramSyncWorker } from './telegram/syncWorker.js';

async function main() {
  const config = loadConfig();
  const store = await createMongoStore(config);
  const digestService = createTelegramDigestService(store);
  const app = createApp({ config, store, digestService });
  const syncWorker = startTelegramSyncWorker({ config, store });

  const server = app.listen(config.port, config.host, () => {
    console.log(`tg-mcp listening on http://${config.host}:${config.port}${config.mcpPath}`);
  });

  async function shutdown(signal) {
    console.log(`Received ${signal}; shutting down.`);
    server.close(async () => {
      await syncWorker.stop();
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
