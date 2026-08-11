import { createAuthorizedTelegramClient, normalizeTelegramReactions, telegramPeerId } from './telegramSync.js';

export async function handleTelegramReactionUpdate({ update, store, allowedSourceIds = [] }) {
  const className = update?.className || update?.constructor?.name || '';
  if (className !== 'UpdateMessageReactions') {
    return { handled: false, reason: 'unsupported_update' };
  }

  const sourceId = telegramPeerId(update.peer);
  if (!sourceId || !Number.isInteger(update.msgId)) {
    return { handled: false, reason: 'invalid_update' };
  }

  const ceiling = new Set(allowedSourceIds.map(String));
  if (ceiling.size && !ceiling.has(sourceId)) {
    return { handled: false, reason: 'outside_allowed_source_ids', sourceId };
  }
  const [source] = await store.listSources({ sourceIds: [sourceId] });
  if (!source) {
    return { handled: false, reason: 'source_not_enabled', sourceId };
  }

  const reactions = normalizeTelegramReactions(update.reactions);
  const result = await store.updateMessageReactions(sourceId, update.msgId, reactions);
  return {
    handled: Boolean(result),
    reason: result ? null : 'message_not_stored',
    sourceId,
    messageId: update.msgId,
    reactions
  };
}

export function createTelegramReactionWorker({
  config,
  store,
  logger = console,
  createClient = createAuthorizedTelegramClient
}) {
  let stopped = false;
  let client = null;
  let startPromise = null;

  async function connect() {
    const connectedClient = await createClient(config);
    if (stopped) {
      await connectedClient.disconnect?.();
      return { started: false };
    }

    client = connectedClient;
    client.addEventHandler(async (update) => {
      try {
        const result = await handleTelegramReactionUpdate({
          update,
          store,
          allowedSourceIds: config.allowedSourceIds || []
        });
        if (result.handled) {
          logger.info(`Telegram reactions updated for ${result.sourceId}:${result.messageId}.`);
        }
      } catch (error) {
        logger.warn(`Telegram reaction update failed: ${error.message}`);
      }
    });
    logger.info('Telegram reaction update listener connected.');
    return { started: true };
  }

  function start() {
    if (!config.telegramSyncEnabled) {
      logger.info('Telegram reaction update listener is disabled with background sync.');
      return { started: false };
    }
    if (!startPromise) {
      startPromise = connect().catch((error) => {
        logger.warn(`Telegram reaction update listener failed to start: ${error.message}`);
        return { started: false, error: error.message };
      });
    }
    return { started: true };
  }

  async function stop() {
    stopped = true;
    if (startPromise) {
      await startPromise;
    }
    if (client && typeof client.disconnect === 'function') {
      await client.disconnect();
      client = null;
    }
  }

  return {
    start,
    stop,
    ready: () => startPromise || Promise.resolve({ started: false })
  };
}

export function startTelegramReactionWorker(options) {
  const worker = createTelegramReactionWorker(options);
  worker.start();
  return worker;
}
