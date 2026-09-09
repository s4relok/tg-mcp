import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonical, fileHash, immutableWrite } from './archiveStore.js';
import { validateManifest, verifySnapshot } from './snapshots.js';

const run = promisify(execFile);

export async function missingReplicaFiles(destination, manifest) {
  validateManifest(manifest);
  const pool = path.join(path.resolve(destination), '.objects');
  await fs.mkdir(pool, { recursive: true, mode: 0o700 });
  const missing = [];
  for (const entry of manifest.files) {
    const file = path.join(pool, entry.sha256);
    try {
      if ((await fs.stat(file)).size !== entry.size || await fileHash(file) !== entry.sha256) throw new Error(`Local backup object is corrupt: ${entry.sha256}`);
    } catch (error) { if (error.code === 'ENOENT') missing.push(entry.path); else throw error; }
  }
  const space = await fs.statfs(destination);
  const inventory = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const required = missing.reduce((sum, name) => sum + inventory.get(name).size, 0);
  // Reserve temporary packed + unpacked data as well as the retained objects.
  if (Number(space.bavail) * Number(space.bsize) < required * 2 + 512 * 1024 ** 2) throw new Error('Insufficient PC disk space for a verified backup transfer');
  return missing;
}

export async function receiveReplica({ destination, manifest, packageFile, jobId }) {
  validateManifest(manifest);
  if (!/^-?\d{1,24}-\d{13}-[a-f0-9-]{36}$/.test(jobId)) throw new Error('Invalid transfer job ID');
  if (!jobId.startsWith(`${manifest.sourceId}-`)) throw new Error('Transfer source does not match manifest');
  const root = path.resolve(destination);
  const incoming = path.join(root, '.incoming', jobId);
  await fs.mkdir(incoming, { recursive: true, mode: 0o700 });
  const inventory = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const listing = (await run('tar', ['-tzf', packageFile], { maxBuffer: 64 * 1024 * 1024 })).stdout.trim().split(/\r?\n/);
  if (new Set(listing).size !== listing.length || listing.some((name) => name !== 'manifest.json' && !inventory.has(name))) throw new Error('Unexpected path in backup transfer');
  const verbose = (await run('tar', ['-tvzf', packageFile], { maxBuffer: 128 * 1024 * 1024 })).stdout.trim().split(/\r?\n/);
  if (verbose.some((line) => !line.startsWith('-'))) throw new Error('Transfer must contain regular files only, no links');
  await run('tar', ['-xzf', packageFile, '-C', incoming]);
  const transported = JSON.parse(await fs.readFile(path.join(incoming, 'manifest.json')));
  if (canonical(transported) !== canonical(manifest)) throw new Error('Transferred manifest does not match prepared snapshot');
  const pool = path.join(root, '.objects');
  await fs.mkdir(pool, { recursive: true, mode: 0o700 });
  const chatRoot = path.join(root, manifest.sourceId);
  await fs.mkdir(chatRoot, { recursive: true, mode: 0o700 });
  const temporary = path.join(chatRoot, `${jobId}.partial`);
  await fs.mkdir(temporary, { mode: 0o700 });
  for (const entry of manifest.files) {
    const object = path.join(pool, entry.sha256);
    try { await fs.access(object); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const unpacked = path.join(incoming, entry.path);
      if ((await fs.stat(unpacked)).size !== entry.size || await fileHash(unpacked) !== entry.sha256) throw new Error(`Transferred file checksum mismatch: ${entry.path}`);
      try { await fs.link(unpacked, object); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const handle = await fs.open(object, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const file = path.join(temporary, entry.path);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.link(object, file);
  }
  await immutableWrite(path.join(temporary, 'manifest.json'), canonical(manifest));
  const verified = await verifySnapshot(temporary, manifest.sourceId);
  const final = path.join(chatRoot, jobId);
  await fs.rename(temporary, final);
  await fs.rm(incoming, { recursive: true });
  return { ...verified, snapshot: final };
}
