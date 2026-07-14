import { createAuthorizedTelegramClient, syncTelegramMessages } from './telegramSync.js';
import { createTelegramSyncCoordinator } from './sourceSyncCoordinator.js';

export function createTelegramSyncWorker({
  config,
  store,
  logger = console,
  createClient = createAuthorizedTelegramClient,
  syncMessages = syncTelegramMessages,
  afterSync,
  coordinator,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let stopped = false;
  let timer = null;
  let running = false;
  const syncCoordinator = coordinator || createTelegramSyncCoordinator({
    config,
    store,
    logger,
    createClient,
    syncMessages,
    afterSync
  });

  async function runOnce() {
    if (running) {
      logger.warn('Telegram sync already running; skipping overlapping tick.');
      return { skipped: true };
    }

    running = true;
    try {
      const result = await syncCoordinator.runDue();
      logger.info(`Telegram sync complete: ${result.messageCount} message(s) from ${result.sourceCount} source(s).`);
      return result;
    } catch (error) {
      logger.warn(`Telegram sync skipped: ${error.message}`);
      return { error: error.message };
    } finally {
      running = false;
    }
  }

  function scheduleNext(delaySeconds = config.sourceSchedulerPollIntervalSeconds || 30) {
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

    logger.info(`Telegram source scheduler enabled with a ${config.sourceSchedulerPollIntervalSeconds || 30}s poll interval.`);
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
