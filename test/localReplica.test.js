import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ArchiveStore, canonical } from '../src/backup/archiveStore.js';
import { missingReplicaFiles, receiveReplica } from '../src/backup/localReplica.js';
import { snapshotManifest, verifySnapshot, restoreSnapshot } from '../src/backup/snapshots.js';
const run = promisify(execFile);

test('PC pull transfers missing objects, verifies snapshots and restores independently after server loss', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-pull-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = new ArchiveStore(path.join(root, 'server'));
  const destination = path.join(root, 'pc');
  await archive.select('123');
  await archive.append('123', [{ kind: 'message', key: '1', payload: { messageId: 1, text: 'first' } }]);
  async function transfer() {
    const manifest = await snapshotManifest(archive, '123');
    const missing = await missingReplicaFiles(destination, manifest);
    const jobId = `123-${Date.now()}-${randomUUID()}`;
    const stage = path.join(root, jobId);
    await fs.mkdir(stage);
    await fs.writeFile(path.join(stage, 'manifest.json'), canonical(manifest));
    const packageFile = path.join(stage, 'payload.tar.gz');
    await run('tar', ['-czf', packageFile, '-C', archive.root, ...missing, '-C', stage, 'manifest.json']);
    const received = await receiveReplica({ destination, manifest, packageFile, jobId });
    return { manifest, missing, received };
  }
  const first = await transfer();
  assert.equal(first.missing.length, first.manifest.files.length);
  await archive.append('123', [{ kind: 'message', key: '1', payload: { messageId: 1, text: 'edited' } }]);
  const second = await transfer();
  assert.equal(second.missing.length, 1);
  await fs.rm(archive.root, { recursive: true });
  await verifySnapshot(first.received.snapshot, '123');
  await verifySnapshot(second.received.snapshot, '123');
  const restored = path.join(root, 'restored');
  await restoreSnapshot('123', second.received.snapshot, restored);
  assert.equal((await new ArchiveStore(restored).view('123')).latest.get('message:1').payload.text, 'edited');
});

test('local replica rejects manifest path traversal before writing outside the destination', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-pull-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(missingReplicaFiles(root, { schemaVersion: 1, sourceId: '123', records: 1,
    files: [{ path: '../escape', size: 1, sha256: 'a'.repeat(64) }] }), /Invalid snapshot file/);
});
