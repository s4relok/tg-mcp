import 'dotenv/config';

const DEFAULT_PUBLIC_BASE_URL = 'https://celticspear.com';

function readNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`${name} must be a number`);
  }

  return value;
}

function readBoolean(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function readList(env, name) {
  const raw = env[name];
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function publicHost(publicBaseUrl) {
  try {
    return new URL(publicBaseUrl).host;
  } catch {
    return null;
  }
}

export function loadConfig(env = process.env) {
  const publicBaseUrl = env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;
  const configuredHosts = readList(env, 'ALLOWED_HOSTS');
  const derivedHost = publicHost(publicBaseUrl);
  const allowedHosts = configuredHosts.length > 0
    ? configuredHosts
    : ['127.0.0.1', 'localhost', ...(derivedHost ? [derivedHost] : [])];

  return {
    nodeEnv: env.NODE_ENV || 'development',
    host: env.HOST || '127.0.0.1',
    port: readNumber(env, 'PORT', 3010),
    publicBaseUrl,
    mcpPath: env.MCP_PATH || '/mcp',
    allowedHosts,
    appAuthToken: env.APP_AUTH_TOKEN || '',

    mongoUrl: env.MONGO_URL || 'mongodb://127.0.0.1:27017',
    mongoDb: env.MONGO_DB || 'tg_mcp',

    telegramMode: env.TELEGRAM_MODE || 'user',
    telegramApiId: env.TELEGRAM_API_ID || '',
    telegramApiHash: env.TELEGRAM_API_HASH || '',
    telegramSessionFile: env.TELEGRAM_SESSION_FILE || './sessions/telegram.session',
    telegramSyncLimit: readNumber(env, 'TELEGRAM_SYNC_LIMIT', 200),
    telegramSyncEnabled: readBoolean(env, 'TELEGRAM_SYNC_ENABLED', false),
    telegramSyncIntervalSeconds: readNumber(env, 'TELEGRAM_SYNC_INTERVAL_SECONDS', 300),
    telegramSyncOnStart: readBoolean(env, 'TELEGRAM_SYNC_ON_START', true),
    allowedSourceIds: readList(env, 'ALLOWED_SOURCE_IDS')
  };
}
