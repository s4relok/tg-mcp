// Server-side staging for a verified pull. No second full copy of the archive
// is created on the VPS: tar reads an immutable committed prefix directly.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfigFromProcessEnv } from '../src/config.js';
import { ArchiveStore, canonical, immutableWrite, exactSourceId } from '../src/backup/archiveStore.js';
import { snapshotManifest, validateManifest } from '../src/backup/snapshots.js';

const config = loadConfigFromProcessEnv();
const archive = new ArchiveStore(config.backupDir);
const stageRoot = path.resolve(archive.root, '..', 'backup-transfer');
const [command, argument, destinationBase64] = process.argv.slice(2);
const run = promisify(execFile);
await fs.mkdir(stageRoot, { recursive: true, mode: 0o700 });
let result;
if (command === 'prepare') {
  const id = exactSourceId(argument);
  if (config.allowedSourceIds.length && !config.allowedSourceIds.includes(id)) throw new Error('Source outside server allowlist');
  const manifest = await snapshotManifest(archive, id);
  const jobId = `${id}-${Date.now()}-${randomUUID()}`;
  const directory = path.join(stageRoot, jobId);
  await fs.mkdir(directory, { mode: 0o700 });
  await immutableWrite(path.join(directory, 'manifest.json'), canonical(manifest));
  result = { jobId, sourceId: id, directory, files: manifest.files.length, records: manifest.records };
} else {
  if (!/^-?\d{1,24}-\d{13}-[a-f0-9-]{36}$/.test(argument || '')) throw new Error('Invalid transfer job ID');
  const directory = path.join(stageRoot, argument);
  const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')));
  if (command === 'pack') {
    const missing = JSON.parse(await fs.readFile(path.join(directory, 'missing.json'), 'utf8'));
    if (!Array.isArray(missing) || new Set(missing).size !== missing.length) throw new Error('Invalid missing-file request');
    const inventory = new Map(manifest.files.map((entry) => [entry.path, entry]));
    if (missing.some((name) => !inventory.has(name))) throw new Error('Transfer requested a file outside its snapshot');
    const required = missing.reduce((sum, name) => sum + inventory.get(name).size, 0);
    await archive.ensureSpace(required + 1024 * 1024);
    await fs.writeFile(path.join(directory, 'files.list'), missing.join('\n') + (missing.length ? '\n' : ''), { mode: 0o600 });
    await run('tar', ['-czf', path.join(directory, 'payload.tar.gz'), '-C', archive.root,
      '--verbatim-files-from', '-T', path.join(directory, 'files.list'), '-C', directory, 'manifest.json']);
    result = { jobId: argument, file: path.join(directory, 'payload.tar.gz'), missing: missing.length, bytes: (await fs.stat(path.join(directory, 'payload.tar.gz'))).size };
  } else if (command === 'ack') {
    const destination = Buffer.from(destinationBase64 || '', 'base64').toString('utf8');
    if (!destination || destination.length > 2000) throw new Error('Missing verified destination');
    // Called only after the pull client verifies every file and the full chain.
    await archive.append(manifest.sourceId, [{ kind: 'health', key: 'replication', payload: {
      status: 'verified', at: new Date().toISOString(), destination, snapshot: argument,
      records: manifest.records, head: manifest.head, verification: 'pull_client_sha256_and_journal'
    } }]);
    await fs.rm(directory, { recursive: true });
    result = { status: 'acknowledged', sourceId: manifest.sourceId, snapshot: argument };
  } else throw new Error('Use prepare SOURCE_ID, pack JOB_ID, or ack JOB_ID DESTINATION_BASE64');
}
console.log(JSON.stringify(result));
