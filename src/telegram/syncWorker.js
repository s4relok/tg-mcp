import { createAuthorizedTelegramClient, syncTelegramMessages } from './telegramSync.js';

export function createTelegramSyncWorker({
  config,
  store,
  logger = console,
  createClient = createAuthorizedTelegramClient,
  syncMessages = syncTelegramMessages,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let stopped = false;
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running) {
      logger.warn('Telegram sync already running; skipping overlapping tick.');
      return { skipped: true };
    }

    running = true;
    let client = null;
    try {
      client = await createClient(config);
      const result = await syncMessages({ client, store, config });
      logger.info(`Telegram sync complete: ${result.messageCount} message(s) from ${result.sourceCount} source(s).`);
      return result;
    } catch (error) {
      logger.warn(`Telegram sync skipped: ${error.message}`);
      return { error: error.message };
    } finally {
      running = false;
      if (client?.disconnect) {
        await client.disconnect();
      }
    }
  }

  function scheduleNext(delaySeconds = config.telegramSyncIntervalSeconds) {
    if (stopped) {
      return;
    }

    timer = setTimer(async () => {
      await runOnce();
      scheduleNext();
    }, Math.max(1, delaySeconds) * 1000);
  }

  function start() {
    if (!config.telegramSyncEnabled) {
      logger.info('Telegram background sync is disabled.');
      return { started: false };
    }

    logger.info(`Telegram background sync enabled every ${config.telegramSyncIntervalSeconds}s.`);
    if (config.telegramSyncOnStart) {
      queueMicrotask(async () => {
        await runOnce();
        scheduleNext();
      });
    } else {
      scheduleNext();
    }

    return { started: true };
  }

  async function stop() {
    stopped = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    runOnce
  };
}

export function startTelegramSyncWorker(options) {
  const worker = createTelegramSyncWorker(options);
  worker.start();
  return worker;
}
