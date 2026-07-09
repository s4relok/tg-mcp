import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { loadConfig } from './config.js';
import { createMongoStore } from './storage/mongoStore.js';
import { createTelegramClient, listTelegramSources, syncTelegramMessages } from './telegram/telegramSync.js';

function usage() {
  console.log(`Usage:
  npm run cli -- list-sources
  npm run cli -- sync
  npm run cli -- backfill --days N
`);
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
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  const config = loadConfig();
  const store = await createMongoStore(config);

  try {
    if (command === 'list-sources') {
      const sources = await withTelegram(config, (client) => listTelegramSources({ client }));
      console.log(JSON.stringify({ sources }, null, 2));
      return;
    }

    if (command === 'sync' || command === 'backfill') {
      const result = await withTelegram(config, (client) => syncTelegramMessages({ client, store, config }));
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
