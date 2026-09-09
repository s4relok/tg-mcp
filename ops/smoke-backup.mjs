import { loadConfigFromProcessEnv } from '../src/config.js';
import { createBackupService } from '../src/backup/backupService.js';

const config = loadConfigFromProcessEnv();
const ids = process.argv.slice(2);
if (!ids.length) throw new Error('Pass exact protected source IDs');
const backup = createBackupService({ config });
for (const sourceId of ids) {
  const status = await backup.status(sourceId);
  const verified = await backup.verify(sourceId);
  const response = await fetch(`http://${config.host}:${config.port}/admin/backups/${sourceId}`, {
    headers: { Authorization: `Bearer ${config.appAuthToken}` }
  });
  if (!response.ok) throw new Error(`Backup admin status failed: ${response.status}`);
  const body = await response.json();
  if (body.sourceId !== sourceId) throw new Error('Backup admin returned a different chat');
  console.log(JSON.stringify({ sourceId, captureEnabled: status.captureEnabled, messages: status.messages,
    historyComplete: status.history.complete, media: status.media, transcripts: status.transcripts,
    verifiedRecords: verified.records, verifiedBlobs: verified.blobs, replica: status.replication.status }));
}
