import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { loadConfigFromProcessEnv } from './config.js';
import { createReadinessReport } from './services/doctor.js';
import { setupEnvFile } from './services/envSetup.js';
import { findSourcesForSelection, selectSource } from './services/sourceAdmin.js';
import { createSourceManagementService } from './services/sourceManagement.js';
import { createMongoStore } from './storage/mongoStore.js';
import { createAudioTranscriptionWorker } from './audio/transcriptionWorker.js';
import {
  createTelegramClient,
  createAuthorizedTelegramClient,
  createTelegramLoginReport,
  listTelegramSources,
  refreshTelegramSources,
  syncTelegramMessages
} from './telegram/telegramSync.js';
import { createTelegramSyncCoordinator } from './telegram/sourceSyncCoordinator.js';

function usage() {
  console.log(`Usage:
  npm run cli -- setup-env [--env-path PATH] [--production] [--force] [--set KEY=VALUE] [--from-env KEY]
  npm run cli -- login [--env-path PATH]
  npm run cli -- list-sources [--env-path PATH]
  npm run cli -- refresh-sources [--env-path PATH]
  npm run cli -- db-sources [--env-path PATH]
  npm run cli -- find-sources QUERY [--env-path PATH]
  npm run cli -- select-source QUERY [--tag TAG] [--env-path PATH]
  npm run cli -- enable-source SOURCE_ID [--tag TAG] [--env-path PATH]
  npm run cli -- disable-source SOURCE_ID [--env-path PATH]
  npm run cli -- set-source-tags SOURCE_ID --tag TAG [--tag TAG] [--env-path PATH]
  npm run cli -- get-source-settings SOURCE_ID [--env-path PATH]
  npm run cli -- update-source-settings SOURCE_ID [settings options] [--expected-version N] [--preview]
  npm run cli -- purge-source-data SOURCE_ID --force [--env-path PATH]
  npm run cli -- sync [--limit N] [--source-id ID] [--env-path PATH]
  npm run cli -- backfill --days N [--env-path PATH]
  npm run cli -- transcribe-audio [--limit N] [--source-id ID] [--env-path PATH]
  npm run cli -- transcription-status [--source-id ID] [--env-path PATH]
  npm run cli -- retry-failed-transcriptions [--limit N] [--source-id ID] [--env-path PATH]
  npm run cli -- doctor [--telegram] [--env-path PATH]
`);
}

function parseBooleanOption(value, name) {
  if (!['true', 'false'].includes(String(value).toLowerCase())) {
    throw new Error(`${name} requires true or false`);
  }
  return String(value).toLowerCase() === 'true';
}

function parseNullableIntegerOption(value, name) {
  if (value === undefined) {
    throw new Error(`${name} requires an integer or inherit`);
  }
  if (['inherit', 'null'].includes(String(value).toLowerCase())) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} requires an integer or inherit`);
  }
  return parsed;
}

function parseArgs(argv) {
  const command = argv[2];
  const options = {
    sourceIds: [],
    tags: [],
    fromEnvKeys: [],
    setValues: {},
    sourceSettings: {},
    positional: []
  };

  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--limit') {
      if (!argv[index + 1]) {
        throw new Error('--limit requires a value');
      }
      options.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === '--days') {
      if (!argv[index + 1]) {
        throw new Error('--days requires a value');
      }
      options.days = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === '--source-id') {
      if (!argv[index + 1]) {
        throw new Error('--source-id requires a value');
      }
      options.sourceIds.push(argv[index + 1]);
      index += 1;
    } else if (arg === '--tag') {
      if (!argv[index + 1]) {
        throw new Error('--tag requires a value');
      }
      options.tags.push(argv[index + 1]);
      index += 1;
    } else if (arg === '--tag-mode' || arg === '--mode') {
      if (!argv[index + 1]) {
        throw new Error(`${arg} requires add, remove, or replace`);
      }
      options.tagMode = argv[index + 1];
      index += 1;
    } else if (arg === '--sync-interval-seconds') {
      options.sourceSettings.syncIntervalSeconds = parseNullableIntegerOption(argv[index + 1], arg);
      index += 1;
    } else if (arg === '--history-depth-days') {
      options.sourceSettings.historyDepthDays = parseNullableIntegerOption(argv[index + 1], arg);
      index += 1;
    } else if (arg === '--priority') {
      options.sourceSettings.priority = parseNullableIntegerOption(argv[index + 1], arg);
      index += 1;
    } else if (arg === '--include-media') {
      options.sourceSettings.includeMedia = parseBooleanOption(argv[index + 1], arg);
      index += 1;
    } else if (arg === '--include-replies') {
      options.sourceSettings.includeReplies = parseBooleanOption(argv[index + 1], arg);
      index += 1;
    } else if (arg === '--include-forwarded-posts') {
      options.sourceSettings.includeForwardedPosts = parseBooleanOption(argv[index + 1], arg);
      index += 1;
    } else if (arg === '--expected-version') {
      options.expectedVersion = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === '--env-path' || arg === '--env-file') {
      if (!argv[index + 1]) {
        throw new Error(`${arg} requires a value`);
      }
      options.envFile = argv[index + 1];
      index += 1;
    } else if (arg === '--set') {
      if (!argv[index + 1]) {
        throw new Error('--set requires KEY=VALUE');
      }
      const [key, ...valueParts] = argv[index + 1].split('=');
      if (!key || !valueParts.length) {
        throw new Error('--set requires KEY=VALUE');
      }
      options.setValues[key] = valueParts.join('=');
      index += 1;
    } else if (arg === '--from-env') {
      if (!argv[index + 1]) {
        throw new Error('--from-env requires a variable name');
      }
      options.fromEnvKeys.push(argv[index + 1]);
      index += 1;
    } else if (arg === '--production') {
      options.production = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--preview') {
      options.preview = true;
    } else if (arg === '--include-disabled') {
      options.includeDisabled = true;
    } else if (arg === '--telegram') {
      options.telegram = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      options.positional.push(arg);
    }
  }

  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  if (options.days !== undefined && (!Number.isInteger(options.days) || options.days < 1)) {
    throw new Error('--days must be a positive integer');
  }

  if (options.expectedVersion !== undefined && (!Number.isInteger(options.expectedVersion) || options.expectedVersion < 0)) {
    throw new Error('--expected-version must be a non-negative integer');
  }

  return { command, options };
}

async function withTelegram(config, callback) {
  const rl = readline.createInterface({ input, output });
  let client = null;
  try {
    const sourceManagementService = createSourceManagementService({ store, config });
    const syncCoordinator = createTelegramSyncCoordinator({
      config,
      store,
      createClient: createAuthorizedTelegramClient
    });

    client = await createTelegramClient(config, {
      ask: (question) => rl.question(question)
    });
    return await callback(client);
  } finally {
    if (client?.disconnect) {
      await client.disconnect();
    }
    rl.close();
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv);
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'setup-env') {
    const fromEnvValues = {};
    for (const key of options.fromEnvKeys) {
      if (process.env[key] === undefined) {
        throw new Error(`Environment variable is not set: ${key}`);
      }
      fromEnvValues[key] = process.env[key];
    }
    const result = await setupEnvFile({
      envFile: options.envFile || '.env',
      production: Boolean(options.production),
      force: Boolean(options.force),
      values: {
        ...fromEnvValues,
        ...options.setValues
      }
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const config = loadConfigFromProcessEnv({
    envFile: options.envFile,
    required: Boolean(options.envFile)
  });

  if (command === 'login') {
    const result = await withTelegram(config, (client) => createTelegramLoginReport({
      client,
      config
    }));
    console.log(JSON.stringify(result, null, 2));
    if (!result.authorized) {
      process.exitCode = 1;
    }
    return;
  }

  let store;
  try {
    store = await createMongoStore(config);
  } catch (caught) {
    if (command !== 'doctor') {
      throw caught;
    }

    store = {
      health: async () => {
        throw caught;
      },
      listSources: async () => {
        throw new Error('MongoDB is unavailable; cannot list Telegram sources.');
      },
      close: async () => {}
    };
  }

  try {
    if (command === 'doctor') {
      const report = await createReadinessReport({
        config,
        store,
        checkTelegram: Boolean(options.telegram),
        envFile: options.envFile || ''
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.status === 'error') {
        process.exitCode = 1;
      }
      return;
    }

    if (command === 'list-sources') {
      const sources = await withTelegram(config, (client) => listTelegramSources({
        client,
        allowedSourceIds: config.allowedSourceIds
      }));
      console.log(JSON.stringify({ sources }, null, 2));
      return;
    }

    if (command === 'refresh-sources') {
      const result = await withTelegram(config, (client) => refreshTelegramSources({
        client,
        store,
        config
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'db-sources') {
      const result = await store.listSources({ includeDisabled: options.includeDisabled });
      console.log(JSON.stringify({ sources: result }, null, 2));
      return;
    }

    if (command === 'find-sources') {
      const query = options.positional.join(' ');
      const result = await findSourcesForSelection(store, {
        query,
        includeDisabled: true
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'select-source') {
      const query = options.positional.join(' ');
      const result = await selectSource(store, {
        query,
        tags: options.tags,
        actor: 'cli',
        sourceManagementService
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'selected') {
        process.exitCode = 1;
      }
      return;
    }

    if (command === 'enable-source') {
      const sourceId = options.positional[0];
      if (!sourceId) {
        throw new Error('enable-source requires SOURCE_ID');
      }
      const result = await sourceManagementService.enableSources({
        sourceIds: [sourceId],
        tags: options.tags,
        tagMode: 'add',
        confirmSensitive: true,
        preview: Boolean(options.preview),
        actor: 'cli'
      });
      console.log(JSON.stringify(result, null, 2));
      if (!['updated', 'unchanged', 'preview'].includes(result.status)) {
        process.exitCode = 1;
      }
      return;
    }

    if (command === 'disable-source') {
      const sourceId = options.positional[0];
      if (!sourceId) {
        throw new Error('disable-source requires SOURCE_ID');
      }
      const result = await sourceManagementService.disableSources({
        sourceIds: [sourceId],
        preview: Boolean(options.preview),
        actor: 'cli'
      });
      console.log(JSON.stringify(result, null, 2));
      if (!['updated', 'unchanged', 'preview'].includes(result.status)) {
        process.exitCode = 1;
      }
      return;
    }

    if (command === 'set-source-tags') {
      const sourceId = options.positional[0];
      if (!sourceId) {
        throw new Error('set-source-tags requires SOURCE_ID');
      }
      const result = await sourceManagementService.setSourceTags({
        sourceIds: [sourceId],
        tags: options.tags,
        tagMode: options.tagMode || 'replace',
        preview: Boolean(options.preview),
        actor: 'cli'
      });
      console.log(JSON.stringify(result, null, 2));
      if (!['updated', 'unchanged', 'preview'].includes(result.status)) {
        process.exitCode = 1;
      }
      return;
    }

    if (command === 'get-source-settings') {
      const sourceId = options.positional[0];
      if (!sourceId) {
        throw new Error('get-source-settings requires SOURCE_ID');
      }
      const result = await sourceManagementService.getSourceSettings(sourceId);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'ok') {
        process.exitCode = 1;
      }
      return;
    }

    if (command === 'update-source-settings') {
      const sourceId = options.positional[0];
      if (!sourceId) {
        throw new Error('update-source-settings requires SOURCE_ID');
      }
      const result = await sourceManagementService.updateSourceSettings({
        sourceId,
        settings: options.sourceSettings,
        expectedVersion: options.expectedVersion,
        preview: Boolean(options.preview),
        actor: 'cli'
      });
      console.log(JSON.stringify(result, null, 2));
      if (!['updated', 'unchanged', 'preview'].includes(result.status)) {
        process.exitCode = 1;
      }
      return;
    }

    if (command === 'purge-source-data') {
      const sourceId = options.positional[0];
      if (!sourceId) {
        throw new Error('purge-source-data requires SOURCE_ID');
      }
      if (!options.force) {
        throw new Error('purge-source-data requires --force');
      }
      const [source] = await store.listSources({ includeDisabled: true, sourceIds: [sourceId] });
      if (!source) {
        throw new Error(`Unknown source: ${sourceId}. Run refresh-sources first.`);
      }
      if (source.enabled) {
        throw new Error('Disable the source before purging its stored data.');
      }
      const result = await store.purgeSourceData(sourceId);
      if (store.appendSourceAudit) {
        await store.appendSourceAudit({
          actor: 'cli',
          action: 'purge_data',
          sourceId,
          before: { sourceId, enabled: false, tags: source.tags || [], settings: source.settings || {} },
          after: { sourceId, enabled: false, tags: source.tags || [], settings: source.settings || {} },
          metadata: {
            deletedMessages: result.deletedMessages,
            deletedDigests: result.deletedDigests
          },
          createdAt: new Date()
        });
      }
      console.log(JSON.stringify({ status: 'purged', sourceId, ...result }, null, 2));
      return;
    }

    if (command === 'sync') {
      const result = await syncCoordinator.run({
        sourceIds: options.sourceIds,
        limit: options.limit,
        reason: 'cli',
        actor: 'cli'
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'backfill') {
      if (!options.days) {
        throw new Error('backfill requires --days N');
      }
      const result = await syncCoordinator.run({
        sourceIds: options.sourceIds,
        limit: options.limit,
        backfillDays: options.days,
        reason: 'cli-backfill',
        actor: 'cli'
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'transcription-status') {
      const result = await store.getAudioTranscriptionStatus({
        sourceIds: options.sourceIds
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'retry-failed-transcriptions') {
      const result = await store.resetFailedAudioTranscriptions({
        sourceIds: options.sourceIds,
        limit: options.limit
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'transcribe-audio') {
      const worker = createAudioTranscriptionWorker({
        config,
        store
      });
      const result = await worker.runOnce({
        sourceIds: options.sourceIds,
        limit: options.limit,
        force: true
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.error) {
        process.exitCode = 1;
      }
      return;
    }

    usage();
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
