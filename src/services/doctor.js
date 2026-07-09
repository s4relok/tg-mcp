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
      return warn('telegram_session', 'Telegram session file is missing. Run an interactive Telegram CLI command first.', { sessionFile });
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

  checks.push(config.appAuthToken
    ? ok('app_auth', 'APP_AUTH_TOKEN is configured.')
    : warn('app_auth', 'APP_AUTH_TOKEN is not configured. Public MCP/REST exposure would be unauthenticated.'));

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
    checks
  };
}
