import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { loadConfig } from './config.js';
import { createMongoStore } from './storage/mongoStore.js';
import { createTelegramClient, listTelegramSources, syncTelegramMessages } from './telegram/telegramSync.js';

function usage() {
  console.log(`Usage:
  npm run cli -- list-sources
  npm run cli -- db-sources
  npm run cli -- sync [--limit N] [--source-id ID]
  npm run cli -- backfill --days N
`);
}

function parseArgs(argv) {
  const command = argv[2];
  const options = {
    sourceIds: []
  };

  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--limit') {
      options.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === '--days') {
      options.days = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === '--source-id') {
      options.sourceIds.push(argv[index + 1]);
      index += 1;
    } else if (arg === '--include-disabled') {
      options.includeDisabled = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
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
  try {
    const client = await createTelegramClient(config, {
      ask: (question) => rl.question(question)
    });
    return await callback(client);
  } finally {
    rl.close();
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv);
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  const config = loadConfig();
  const store = await createMongoStore(config);

  try {
    if (command === 'list-sources') {
      const sources = await withTelegram(config, (client) => listTelegramSources({
        client,
        allowedSourceIds: config.allowedSourceIds
      }));
      console.log(JSON.stringify({ sources }, null, 2));
      return;
    }

    if (command === 'db-sources') {
      const result = await store.listSources({ includeDisabled: options.includeDisabled });
      console.log(JSON.stringify({ sources: result }, null, 2));
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
