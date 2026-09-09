import { loadConfigFromProcessEnv } from '../src/config.js';
import { createMongoStore } from '../src/storage/mongoStore.js';
import { createBackupService } from '../src/backup/backupService.js';
import { exactSourceId } from '../src/backup/archiveStore.js';
import { runDailyBackup } from '../src/backup/dailyBackup.js';

const sourceIds = [...new Set(process.argv.slice(2).map(exactSourceId))];
if (!sourceIds.length) throw new Error('Pass the exact source IDs for daily backups');
const config = loadConfigFromProcessEnv();
const store = await createMongoStore(config);
const backup = createBackupService({ config, store });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => backup.requestStop());
try {
  for (const sourceId of sourceIds) {
    try { console.log(JSON.stringify(await runDailyBackup({ backup, store, sourceId }))); }
    catch (error) { console.error(JSON.stringify({ sourceId, status: 'error', error: error.message })); process.exitCode = 1; }
  }
} finally { await store.close(); }
