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
    chatGptMcpPath: env.CHATGPT_MCP_PATH || '',
    restBasePath: env.REST_BASE_PATH || '/tg-mcp/api',
    openApiPath: env.OPENAPI_PATH || '/tg-mcp/openapi.json',
    allowedHosts,
    appAuthToken: env.APP_AUTH_TOKEN || '',
    allowUnauthenticated: readBoolean(env, 'ALLOW_UNAUTHENTICATED', false),

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
    allowedSourceIds: readList(env, 'ALLOWED_SOURCE_IDS'),

    openAiApiKey: env.OPENAI_API_KEY || '',
    openAiTranscriptionEnabled: readBoolean(env, 'OPENAI_TRANSCRIPTION_ENABLED', false),
    openAiTranscriptionModel: env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe',
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
