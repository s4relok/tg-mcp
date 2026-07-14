import fs from 'node:fs';

import { parse as parseDotenv } from 'dotenv';

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

function publicUrl(publicBaseUrl, pathname) {
  try {
    return new URL(pathname, publicBaseUrl).href;
  } catch {
    return '';
  }
}

function protectedResourceMetadataUrl(resource) {
  try {
    const url = new URL(resource);
    const resourcePath = url.pathname === '/' ? '' : url.pathname;
    return new URL(`/.well-known/oauth-protected-resource${resourcePath}`, url).href;
  } catch {
    return '';
  }
}

export function loadConfig(env = process.env) {
  const publicBaseUrl = env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;
  const oauthMcpPath = env.OAUTH_MCP_PATH || '/tg-mcp/oauth-mcp';
  const oauthResource = env.OAUTH_RESOURCE || publicUrl(publicBaseUrl, oauthMcpPath);
  const oauthJwtAlgorithms = readList(env, 'OAUTH_JWT_ALGORITHMS');
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
    chatGptMcpPath: env.CHATGPT_MCP_PATH || '',
    restBasePath: env.REST_BASE_PATH || '/tg-mcp/api',
    openApiPath: env.OPENAPI_PATH || '/tg-mcp/openapi.json',
    allowedHosts,
    appAuthToken: env.APP_AUTH_TOKEN || '',
    allowUnauthenticated: readBoolean(env, 'ALLOW_UNAUTHENTICATED', false),

    oauthEnabled: readBoolean(env, 'OAUTH_ENABLED', false),
    oauthMcpPath,
    oauthResource,
    oauthProtectedResourceMetadataUrl: protectedResourceMetadataUrl(oauthResource),
    oauthIssuer: env.OAUTH_ISSUER || '',
    oauthJwksUrl: env.OAUTH_JWKS_URL || '',
    oauthJwtAlgorithms: oauthJwtAlgorithms.length > 0
      ? oauthJwtAlgorithms
      : ['RS256', 'ES256'],
    oauthAllowedSubjects: readList(env, 'OAUTH_ALLOWED_SUBJECTS'),
    oauthClockToleranceSeconds: readNumber(env, 'OAUTH_CLOCK_TOLERANCE_SECONDS', 5),
    oauthJwksTimeoutMs: readNumber(env, 'OAUTH_JWKS_TIMEOUT_MS', 5000),
    oauthResourceDocumentation: env.OAUTH_RESOURCE_DOCUMENTATION || '',

    mongoUrl: env.MONGO_URL || 'mongodb://127.0.0.1:27017',
    mongoDb: env.MONGO_DB || 'tg_mcp',
    mongoServerSelectionTimeoutMs: readNumber(env, 'MONGO_SERVER_SELECTION_TIMEOUT_MS', 5000),

    telegramMode: env.TELEGRAM_MODE || 'user',
    telegramApiId: env.TELEGRAM_API_ID || '',
    telegramApiHash: env.TELEGRAM_API_HASH || '',
    telegramSessionFile: env.TELEGRAM_SESSION_FILE || './sessions/telegram.session',
    telegramSyncLimit: readNumber(env, 'TELEGRAM_SYNC_LIMIT', 200),
    telegramSyncEnabled: readBoolean(env, 'TELEGRAM_SYNC_ENABLED', false),
    telegramSyncIntervalSeconds: readNumber(env, 'TELEGRAM_SYNC_INTERVAL_SECONDS', 300),
    telegramSyncOnStart: readBoolean(env, 'TELEGRAM_SYNC_ON_START', true),
    telegramSyncMaxLimit: readNumber(env, 'TELEGRAM_SYNC_MAX_LIMIT', 1000),
    allowedSourceIds: readList(env, 'ALLOWED_SOURCE_IDS'),

    sourceDefaultSyncIntervalSeconds: readNumber(
      env,
      'SOURCE_DEFAULT_SYNC_INTERVAL_SECONDS',
      readNumber(env, 'TELEGRAM_SYNC_INTERVAL_SECONDS', 300)
    ),
    sourceDefaultHistoryDepthDays: readNumber(env, 'SOURCE_DEFAULT_HISTORY_DEPTH_DAYS', 30),
    sourceDefaultIncludeMedia: readBoolean(env, 'SOURCE_DEFAULT_INCLUDE_MEDIA', true),
    sourceDefaultIncludeReplies: readBoolean(env, 'SOURCE_DEFAULT_INCLUDE_REPLIES', true),
    sourceDefaultIncludeForwardedPosts: readBoolean(env, 'SOURCE_DEFAULT_INCLUDE_FORWARDED_POSTS', true),
    sourceDefaultPriority: readNumber(env, 'SOURCE_DEFAULT_PRIORITY', 50),
    sourceSchedulerPollIntervalSeconds: readNumber(env, 'SOURCE_SCHEDULER_POLL_INTERVAL_SECONDS', 30),
    sourceSchedulerBatchSize: readNumber(env, 'SOURCE_SCHEDULER_BATCH_SIZE', 10),
    sourceSyncLockSeconds: readNumber(env, 'SOURCE_SYNC_LOCK_SECONDS', 15 * 60),
    sourceMutationBatchLimit: readNumber(env, 'SOURCE_MUTATION_BATCH_LIMIT', 25),
    mcpSourceManagementEnabled: readBoolean(env, 'MCP_SOURCE_MANAGEMENT_ENABLED', false),

    openAiApiKey: env.OPENAI_API_KEY || '',
    openAiTranscriptionEnabled: readBoolean(env, 'OPENAI_TRANSCRIPTION_ENABLED', false),
    openAiTranscriptionModel: env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    openAiTranscriptionResponseFormat: env.OPENAI_TRANSCRIPTION_RESPONSE_FORMAT || 'json',
    openAiTranscriptionPrompt: env.OPENAI_TRANSCRIPTION_PROMPT || '',
    openAiTranscriptionLanguage: env.OPENAI_TRANSCRIPTION_LANGUAGE || '',
    openAiTranscriptionChunkingStrategy: env.OPENAI_TRANSCRIPTION_CHUNKING_STRATEGY || '',
    audioTranscriptionSourceIds: readList(env, 'AUDIO_TRANSCRIPTION_SOURCE_IDS'),
    audioTranscriptionSourceTags: readList(env, 'AUDIO_TRANSCRIPTION_SOURCE_TAGS'),
    audioTranscriptionIntervalSeconds: readNumber(env, 'AUDIO_TRANSCRIPTION_INTERVAL_SECONDS', 3600),
    audioTranscriptionOnStart: readBoolean(env, 'AUDIO_TRANSCRIPTION_ON_START', true),
    audioTranscriptionBatchSize: readNumber(env, 'AUDIO_TRANSCRIPTION_BATCH_SIZE', 1),
    audioTranscriptionLockMs: readNumber(env, 'AUDIO_TRANSCRIPTION_LOCK_MS', 10 * 60 * 1000),
    audioTranscriptionMaxAttempts: readNumber(env, 'AUDIO_TRANSCRIPTION_MAX_ATTEMPTS', 3),
    audioTranscriptionWorkDir: env.AUDIO_TRANSCRIPTION_WORK_DIR || './tmp/audio-transcriptions',
    audioTranscriptionMaxFileBytes: readNumber(env, 'AUDIO_TRANSCRIPTION_MAX_FILE_BYTES', 25 * 1024 * 1024),
    audioTranscriptionSplitLargeFiles: readBoolean(env, 'AUDIO_TRANSCRIPTION_SPLIT_LARGE_FILES', true),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',

    telegramBotEnabled: readBoolean(env, 'TELEGRAM_BOT_ENABLED', false),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramBotAllowedChatIds: readList(env, 'TELEGRAM_BOT_ALLOWED_CHAT_IDS'),
    telegramBotTimezone: env.TELEGRAM_BOT_TIMEZONE || 'Europe/Chisinau'
  };
}

export function assertSafeRuntimeConfig(config) {
  if (config.nodeEnv === 'production' && !config.appAuthToken && !config.allowUnauthenticated) {
    throw new Error('APP_AUTH_TOKEN is required when NODE_ENV=production. Set APP_AUTH_TOKEN or explicitly set ALLOW_UNAUTHENTICATED=true for a private test environment.');
  }

  if (!config.oauthEnabled) {
    return;
  }

  for (const [name, value] of [
    ['OAUTH_RESOURCE', config.oauthResource],
    ['OAUTH_ISSUER', config.oauthIssuer],
    ['OAUTH_JWKS_URL', config.oauthJwksUrl]
  ]) {
    if (!value) {
      throw new Error(`${name} is required when OAUTH_ENABLED=true`);
    }
  }

  const urls = [
    ['OAUTH_RESOURCE', config.oauthResource],
    ['OAUTH_ISSUER', config.oauthIssuer],
    ['OAUTH_JWKS_URL', config.oauthJwksUrl],
    ...(config.oauthResourceDocumentation
      ? [['OAUTH_RESOURCE_DOCUMENTATION', config.oauthResourceDocumentation]]
      : [])
  ];
  for (const [name, value] of urls) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must be an absolute URL`);
    }
    const isLocalDevelopment = config.nodeEnv !== 'production'
      && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !isLocalDevelopment) {
      throw new Error(`${name} must use HTTPS`);
    }
    if (url.hash) {
      throw new Error(`${name} must not include a URL fragment`);
    }
    if (['OAUTH_RESOURCE', 'OAUTH_ISSUER'].includes(name) && url.search) {
      throw new Error(`${name} must not include a query string`);
    }
  }

  const pathCollisions = [config.mcpPath, config.chatGptMcpPath].filter(Boolean);
  if (!config.oauthMcpPath || !config.oauthMcpPath.startsWith('/')) {
    throw new Error('OAUTH_MCP_PATH must start with /');
  }
  if (pathCollisions.includes(config.oauthMcpPath)) {
    throw new Error('OAUTH_MCP_PATH must be different from MCP_PATH and CHATGPT_MCP_PATH');
  }
  if (!Array.isArray(config.oauthJwtAlgorithms) || config.oauthJwtAlgorithms.length === 0) {
    throw new Error('OAUTH_JWT_ALGORITHMS must contain at least one asymmetric JWT algorithm');
  }
  if (config.oauthJwtAlgorithms.some((algorithm) => !/^(RS|PS|ES)\d+$|^EdDSA$/.test(algorithm))) {
    throw new Error('OAUTH_JWT_ALGORITHMS may contain only asymmetric RS*, PS*, ES*, or EdDSA algorithms');
  }
  if (config.oauthClockToleranceSeconds < 0 || config.oauthClockToleranceSeconds > 300) {
    throw new Error('OAUTH_CLOCK_TOLERANCE_SECONDS must be between 0 and 300');
  }
  if (config.oauthJwksTimeoutMs < 100 || config.oauthJwksTimeoutMs > 60000) {
    throw new Error('OAUTH_JWKS_TIMEOUT_MS must be between 100 and 60000');
  }
}

export function loadEnvFile(envFile, { required = false } = {}) {
  if (!envFile) {
    return {};
  }

  try {
    return parseDotenv(fs.readFileSync(envFile, 'utf8'));
  } catch (caught) {
    if (caught.code === 'ENOENT') {
      if (required) {
        throw new Error(`Env file not found: ${envFile}`);
      }
      return {};
    }
    throw caught;
  }
}

export function loadConfigFromProcessEnv(options = {}) {
  const envFile = options.envFile ?? process.env.TG_MCP_ENV_FILE ?? '.env';
  const required = options.required ?? Boolean(options.envFile || process.env.TG_MCP_ENV_FILE);
  const fileEnv = loadEnvFile(envFile, { required });
  return loadConfig({
    ...fileEnv,
    ...process.env
  });
}
