import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { loadConfig } from './config.js';
import { createReadinessReport } from './services/doctor.js';
import { setupEnvFile } from './services/envSetup.js';
import { findSourcesForSelection, selectSource } from './services/sourceAdmin.js';
import { createMongoStore } from './storage/mongoStore.js';
import {
  createTelegramClient,
  createTelegramLoginReport,
  listTelegramSources,
  refreshTelegramSources,
  syncTelegramMessages
} from './telegram/telegramSync.js';

function usage() {
  console.log(`Usage:
  npm run cli -- setup-env [--env-path PATH] [--production] [--force] [--set KEY=VALUE] [--from-env KEY]
  npm run cli -- login
  npm run cli -- list-sources
  npm run cli -- refresh-sources
  npm run cli -- db-sources
  npm run cli -- find-sources QUERY
  npm run cli -- select-source QUERY [--tag TAG]
  npm run cli -- enable-source SOURCE_ID [--tag TAG]
  npm run cli -- disable-source SOURCE_ID
  npm run cli -- set-source-tags SOURCE_ID --tag TAG [--tag TAG]
  npm run cli -- sync [--limit N] [--source-id ID]
  npm run cli -- backfill --days N
  npm run cli -- doctor [--telegram]
`);
}

function parseArgs(argv) {
  const command = argv[2];
  const options = {
    sourceIds: [],
    tags: [],
    fromEnvKeys: [],
    setValues: {},
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

  return { command, options };
}

function minDateFromDays(days) {
  if (!days) {
    return undefined;
  }

  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function withTelegram(config, callback) {
  const rl = readline.createInterface({ input, output });
  let client = null;
  try {
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

  const config = loadConfig();

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
        checkTelegram: Boolean(options.telegram)
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
        tags: options.tags
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
      const source = await store.setSourceEnabled(sourceId, true);
      if (!source) {
        throw new Error(`Unknown source: ${sourceId}. Run refresh-sources first.`);
      }
      if (options.tags.length) {
        await store.setSourceTags(sourceId, options.tags);
      }
      const [updated] = await store.listSources({ includeDisabled: true, sourceIds: [sourceId] });
      console.log(JSON.stringify({ source: updated }, null, 2));
      return;
    }

    if (command === 'disable-source') {
      const sourceId = options.positional[0];
      if (!sourceId) {
        throw new Error('disable-source requires SOURCE_ID');
      }
      const source = await store.setSourceEnabled(sourceId, false);
      if (!source) {
        throw new Error(`Unknown source: ${sourceId}. Run refresh-sources first.`);
      }
      const [updated] = await store.listSources({ includeDisabled: true, sourceIds: [sourceId] });
      console.log(JSON.stringify({ source: updated }, null, 2));
      return;
    }

    if (command === 'set-source-tags') {
      const sourceId = options.positional[0];
      if (!sourceId) {
        throw new Error('set-source-tags requires SOURCE_ID');
      }
      const source = await store.setSourceTags(sourceId, options.tags);
      if (!source) {
        throw new Error(`Unknown source: ${sourceId}. Run refresh-sources first.`);
      }
      const [updated] = await store.listSources({ includeDisabled: true, sourceIds: [sourceId] });
      console.log(JSON.stringify({ source: updated }, null, 2));
      return;
    }

    if (command === 'sync') {
      const result = await withTelegram(config, (client) => syncTelegramMessages({
        client,
        store,
        config,
        sourceIds: options.sourceIds,
        limit: options.limit
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'backfill') {
      const result = await withTelegram(config, (client) => syncTelegramMessages({
        client,
        store,
        config,
        sourceIds: options.sourceIds,
        limit: options.limit,
        minDate: minDateFromDays(options.days)
      }));
      console.log(JSON.stringify(result, null, 2));
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
