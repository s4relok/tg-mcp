import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArchiveStore, canonical, exactSourceId, fileHash, immutableWrite } from './archiveStore.js';

function disjoint(left, right) {
  const relative = path.relative(left, right);
  return relative && (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative));
}

export async function independentDirectory(local, destination) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const [a, b] = await Promise.all([fs.realpath(local), fs.realpath(destination)]);
  if (!disjoint(a, b) || !disjoint(b, a)) throw new Error('Backup destination and local archive must be separate directories');
  return b;
}

function safeEntry(name, sourceId) {
  return name === `${sourceId}/selection.json`
    || new RegExp(`^${sourceId}/records/\\d{12}-[a-f0-9]{64}\\.json$`).test(name)
    || new RegExp(`^${sourceId}/blobs/[a-f0-9]{64}$`).test(name);
}

export async function verifySnapshot(directory, sourceId) {
  const id = exactSourceId(sourceId);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.sourceId !== id || !Array.isArray(manifest.files)) throw new Error('Invalid snapshot manifest');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!safeEntry(entry.path, id) || seen.has(entry.path)) throw new Error('Invalid or duplicate snapshot path');
    seen.add(entry.path);
    const file = path.join(directory, entry.path);
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Snapshot symlinks are not allowed');
    const real = await fs.realpath(file);
    if (path.relative(await fs.realpath(directory), real).startsWith('..')) throw new Error('Snapshot path escapes its root');
    if ((await fs.stat(file)).size !== entry.size || await fileHash(file) !== entry.sha256) throw new Error(`Snapshot checksum mismatch: ${entry.path}`);
  }
  if (!seen.has(`${id}/selection.json`)) throw new Error('Snapshot is missing its selection');
  const archive = new ArchiveStore(directory);
  const result = await archive.verify(id, { readOnly: true });
  if (result.head !== manifest.head || result.records !== manifest.records) throw new Error('Snapshot journal does not match manifest');
  const state = await archive.view(id);
  for (const record of state.records) {
    if (!seen.has(`${id}/records/${record.file}`)) throw new Error('Manifest is missing a journal record');
    if (['media', 'cached_media'].includes(record.kind) && record.payload.status === 'saved'
      && !seen.has(`${id}/blobs/${record.payload.sha256}`)) throw new Error('Manifest is missing an archived blob');
  }
  return { ...result, createdAt: manifest.createdAt, snapshot: path.resolve(directory) };
}

export async function exportSnapshot(archive, sourceId, destination) {
  const id = await archive.assertSelected(sourceId);
  const root = await independentDirectory(archive.root, path.resolve(destination));
  // Capture a committed journal prefix under the writer lock. Immutable files
  // can then be copied while the live archive continues to grow.
  const snapshot = await archive.locked(async () => {
    const state = await archive.view(id, { fresh: true });
    const files = new Set([`${id}/selection.json`]);
    for (const record of state.records) {
      files.add(`${id}/records/${record.file}`);
      if (['media', 'cached_media'].includes(record.kind) && record.payload.status === 'saved') files.add(`${id}/blobs/${record.payload.sha256}`);
    }
    return { head: state.head, records: state.seq, files: [...files].sort() };
  });
  const name = `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const temporary = path.join(root, `${name}.partial`);
  await fs.mkdir(temporary, { mode: 0o700 });
  const files = [];
  for (const relative of snapshot.files) {
    const source = path.join(archive.root, relative);
    const target = path.join(temporary, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    await fs.chmod(target, 0o600);
    const handle = await fs.open(target, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    files.push({ path: relative, size: (await fs.stat(target)).size, sha256: await fileHash(target) });
  }
  await immutableWrite(path.join(temporary, 'manifest.json'), canonical({
    schemaVersion: 1, sourceId: id, createdAt: new Date().toISOString(),
    head: snapshot.head, records: snapshot.records, files,
    search: { fields: ['text', 'transcriptText', 'senderName'], format: 'journal projection v1' }
  }));
  await verifySnapshot(temporary, id);
  const final = path.join(root, name);
  await fs.rename(temporary, final);
  return { status: 'verified', sourceId: id, snapshot: final, records: snapshot.records, head: snapshot.head };
}

export async function restoreSnapshot(sourceId, snapshot, target) {
  const id = exactSourceId(sourceId);
  await verifySnapshot(snapshot, id);
  const absolute = path.resolve(target);
  // Never merge into or overwrite an existing archive or database.
  try { await fs.lstat(absolute); throw new Error('Restore target must not exist'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const parent = await fs.realpath(path.dirname(absolute));
  const snapshotRoot = await fs.realpath(snapshot);
  const targetRoot = path.join(parent, path.basename(absolute));
  if (!disjoint(snapshotRoot, targetRoot) || !disjoint(targetRoot, snapshotRoot)) throw new Error('Restore target must be separate from snapshot');
  const temporary = path.join(parent, `.restore-${randomUUID()}.partial`);
  await fs.mkdir(temporary, { mode: 0o700 });
  const manifest = JSON.parse(await fs.readFile(path.join(snapshot, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files) {
    const destination = path.join(temporary, entry.path);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(snapshot, entry.path), destination, fs.constants.COPYFILE_EXCL);
  }
  const archive = new ArchiveStore(temporary);
  // Restores are offline by default, even if the snapshot was captured live.
  await archive.append(id, [{ kind: 'control', key: 'capture', payload: { enabled: false, reason: 'restored' } }]);
  const result = await archive.verify(id);
  await fs.rename(temporary, absolute);
  return { ...result, restoredTo: absolute, captureEnabled: false };
}
