import fs from 'node:fs/promises';

import { createAuthorizedTelegramClient } from '../telegram/telegramSync.js';

function ok(name, message, details = {}) {
  return { name, status: 'ok', message, details };
}

function warn(name, message, details = {}) {
  return { name, status: 'warning', message, details };
}

function error(name, message, details = {}) {
  return { name, status: 'error', message, details };
}

async function sessionFileStatus(sessionFile) {
  try {
    const stat = await fs.stat(sessionFile);
    if (stat.size <= 0) {
      return warn('telegram_session', 'Telegram session file exists but is empty.', { sessionFile });
    }

    return ok('telegram_session', 'Telegram session file exists.', {
      sessionFile,
      bytes: stat.size
    });
  } catch (caught) {
    if (caught.code === 'ENOENT') {
      return warn('telegram_session', 'Telegram session file is missing. Run npm run cli -- login interactively first.', { sessionFile });
    }
    return error('telegram_session', caught.message, { sessionFile });
  }
}

function summarize(checks) {
  const errors = checks.filter((check) => check.status === 'error').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  return {
    status: errors ? 'error' : warnings ? 'warning' : 'ok',
    errors,
    warnings,
    ok: checks.filter((check) => check.status === 'ok').length
  };
}

function findCheck(checks, name) {
  return checks.find((check) => check.name === name);
}

function addUniqueStep(steps, step) {
  if (!steps.some((item) => item.id === step.id)) {
    steps.push(step);
  }
}

function createNextSteps(checks) {
  const steps = [];
  const mongodb = findCheck(checks, 'mongodb');
  const appAuth = findCheck(checks, 'app_auth');
  const telegramCredentials = findCheck(checks, 'telegram_credentials');
  const telegramSession = findCheck(checks, 'telegram_session');
  const telegramAuth = findCheck(checks, 'telegram_auth');
  const telegramSources = findCheck(checks, 'telegram_sources');
  const telegramBot = findCheck(checks, 'telegram_bot');

  if (mongodb?.status === 'error') {
    addUniqueStep(steps, {
      id: 'fix_mongodb',
      reason: 'MongoDB is not reachable.',
      command: 'Check MONGO_URL/MONGO_DB and make sure MongoDB is running.'
    });
  }

  if (appAuth?.status && appAuth.status !== 'ok') {
    addUniqueStep(steps, {
      id: 'set_app_auth',
      reason: 'MCP/REST should not be exposed without an auth token.',
      command: 'npm run cli -- setup-env'
    });
  }

  if (telegramCredentials?.status === 'warning') {
    addUniqueStep(steps, {
      id: 'set_telegram_credentials',
      reason: 'Telegram API credentials are required before login and sync.',
      command: 'export TELEGRAM_API_ID=<api_id>; export TELEGRAM_API_HASH=<api_hash>; npm run cli -- setup-env --from-env TELEGRAM_API_ID --from-env TELEGRAM_API_HASH'
    });
  }

  if (telegramSession?.status !== 'ok' || telegramAuth?.status === 'error') {
    addUniqueStep(steps, {
      id: 'login_telegram',
      reason: 'A valid Telegram user session is required before reading selected chats.',
      command: 'npm run cli -- login && npm run cli -- doctor --telegram'
    });
  }

  if (telegramSources?.status === 'warning') {
    const total = telegramSources.details?.total || 0;
    addUniqueStep(steps, {
      id: 'select_telegram_sources',
      reason: total
        ? 'Telegram sources exist in MongoDB but none are enabled.'
        : 'Telegram sources have not been imported into MongoDB yet.',
      command: total
        ? 'npm run cli -- find-sources <query>; npm run cli -- select-source "<title or id>" --tag work; npm run cli -- sync'
        : 'npm run cli -- refresh-sources; npm run cli -- find-sources <query>; npm run cli -- select-source "<title or id>" --tag work; npm run cli -- sync'
    });
  }

  if (telegramBot?.status === 'error') {
    addUniqueStep(steps, {
      id: 'fix_telegram_bot',
      reason: 'The optional Telegram slash bot is enabled but missing required configuration.',
      command: 'Set TELEGRAM_BOT_TOKEN or set TELEGRAM_BOT_ENABLED=false, then restart the service.'
    });
  } else if (telegramBot?.status === 'warning') {
    addUniqueStep(steps, {
      id: 'restrict_telegram_bot',
      reason: 'The optional Telegram slash bot is enabled for every chat.',
      command: 'Set TELEGRAM_BOT_ALLOWED_CHAT_IDS=<chat_id>[,<chat_id>] and restart the service.'
    });
  }

  if (!steps.length) {
    steps.push({
      id: 'deploy_or_connect',
      reason: 'Core readiness checks are passing.',
      command: 'Deploy the service and connect ChatGPT to the MCP endpoint.'
    });
  }

  return steps;
}

function telegramBotStatus(config) {
  if (!config.telegramBotEnabled) {
    return ok('telegram_bot', 'Telegram slash bot is disabled.');
  }

  if (!config.telegramBotToken) {
    return error('telegram_bot', 'TELEGRAM_BOT_ENABLED is true but TELEGRAM_BOT_TOKEN is empty.');
  }

  const allowedChatCount = config.telegramBotAllowedChatIds?.length || 0;
  if (!allowedChatCount) {
    return warn('telegram_bot', 'Telegram slash bot is enabled without TELEGRAM_BOT_ALLOWED_CHAT_IDS.', {
      allowedChatCount
    });
  }

  return ok('telegram_bot', 'Telegram slash bot is configured.', {
    allowedChatCount
  });
}

function appAuthStatus(config) {
  if (config.appAuthToken) {
    return ok('app_auth', 'APP_AUTH_TOKEN is configured.');
  }

  if (config.nodeEnv === 'production' && !config.allowUnauthenticated) {
    return error('app_auth', 'APP_AUTH_TOKEN is required when NODE_ENV=production.');
  }

  return warn('app_auth', 'APP_AUTH_TOKEN is not configured. Public MCP/REST exposure would be unauthenticated.');
}

export async function createReadinessReport({
  config,
  store,
  checkTelegram = false,
  createClient = createAuthorizedTelegramClient
}) {
  const checks = [];

  checks.push(ok('http_config', 'HTTP paths are configured.', {
    publicBaseUrl: config.publicBaseUrl,
    mcpPath: config.mcpPath,
    restBasePath: config.restBasePath,
    openApiPath: config.openApiPath
  }));

  checks.push(appAuthStatus(config));

  try {
    checks.push(ok('mongodb', 'MongoDB ping succeeded.', await store.health()));
  } catch (caught) {
    checks.push(error('mongodb', caught.message));
  }

  try {
    const allSources = await store.listSources({ includeDisabled: true });
    const enabledSources = allSources.filter((source) => source.enabled !== false);
    checks.push(enabledSources.length
      ? ok('telegram_sources', 'At least one Telegram source is enabled.', {
        total: allSources.length,
        enabled: enabledSources.length
      })
      : warn('telegram_sources', 'No Telegram sources are enabled yet. Run refresh-sources and enable-source.', {
        total: allSources.length,
        enabled: 0
      }));
  } catch (caught) {
    checks.push(error('telegram_sources', caught.message));
  }

  checks.push(config.telegramApiId && config.telegramApiHash
    ? ok('telegram_credentials', 'Telegram API credentials are configured.')
    : warn('telegram_credentials', 'TELEGRAM_API_ID and TELEGRAM_API_HASH are not fully configured.'));

  checks.push(telegramBotStatus(config));

  checks.push(await sessionFileStatus(config.telegramSessionFile));

  if (checkTelegram) {
    let client = null;
    try {
      client = await createClient(config);
      checks.push(ok('telegram_auth', 'Telegram session authorization succeeded.'));
    } catch (caught) {
      checks.push(error('telegram_auth', caught.message));
    } finally {
      if (client?.disconnect) {
        await client.disconnect();
      }
    }
  }

  const summary = summarize(checks);
  return {
    status: summary.status,
    generatedAt: new Date().toISOString(),
    summary,
    nextSteps: createNextSteps(checks),
    checks
  };
}
