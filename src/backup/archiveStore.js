import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function exactSourceId(value) {
  const id = String(value ?? '');
  if (!/^-?\d{1,24}$/.test(id)) throw new Error('Backup requires one exact numeric sourceId');
  return id;
}

export function canonical(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().filter((key) => item[key] !== undefined)
        .map((key) => [key, item[key]]));
    }
    return item;
  });
}

export const hash = (value) => createHash('sha256').update(value).digest('hex');
const recordName = (seq, digest) => `${String(seq).padStart(12, '0')}-${digest}.json`;
const isRecord = (name) => /^\d{12}-[a-f0-9]{64}\.json$/.test(name);
const isHash = (value) => /^[a-f0-9]{64}$/.test(value);

export async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// Publish complete files without ever replacing an existing committed object.
export async function immutableWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.partial`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  try {
    await fs.link(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export class ArchiveStore {
  constructor(root, { minFreeBytes = 512 * 1024 ** 2 } = {}) {
    this.root = path.resolve(root);
    this.minFreeBytes = minFreeBytes;
    this.cache = new Map();
    this.serial = Promise.resolve();
  }

  sourceRoot(sourceId) { return path.join(this.root, exactSourceId(sourceId)); }

  async ensureSpace(bytes = 0) {
    const stat = await fs.statfs(this.root);
    if (Number(stat.bavail) * Number(stat.bsize) < this.minFreeBytes + bytes) {
      throw Object.assign(new Error('Backup paused: insufficient disk space; existing data is retained'), { code: 'ENOSPC' });
    }
  }

  async selected(sourceId) { return readJson(path.join(this.sourceRoot(sourceId), 'selection.json')); }

  async selections() {
    let directories;
    try { directories = await fs.readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const directory of directories) {
      if (!directory.isDirectory() || !/^-?\d{1,24}$/.test(directory.name)) continue;
      const selected = await this.selected(directory.name);
      if (selected && selected.sourceId !== directory.name) throw new Error('Archive selection does not match its directory');
      if (selected) result.push(selected);
    }
    return result;
  }

  async assertSelected(sourceId) {
    const id = exactSourceId(sourceId);
    const selected = await this.selected(id);
    if (!selected || selected.sourceId !== id) throw new Error('This source has no local backup');
    return id;
  }

  // A same-host process lock has no time-based expiry during downloads. A dead
  // owner is recovered; a live owner can never lose its lock to a slow worker.
  async locked(callback) {
    const previous = this.serial;
    let release;
    this.serial = new Promise((resolve) => { release = resolve; });
    await previous;
    const lock = path.join(this.root, '.writer-lock');
    let acquired = false;
    try {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await fs.mkdir(lock);
          acquired = true;
          await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const owner = await readJson(path.join(lock, 'owner.json'));
          if (owner) {
            try { process.kill(owner.pid, 0); }
            catch (error) {
              if (error.code === 'ESRCH') {
                // Serialize recovery and re-read the owner: another recovering
                // writer may have replaced the dead lock with its own live lock.
                const recovery = path.join(this.root, '.lock-recovery');
                let recovering = false;
                try {
                  await fs.mkdir(recovery);
                  recovering = true;
                  const current = await readJson(path.join(lock, 'owner.json'));
                  if (current) {
                    try { process.kill(current.pid, 0); }
                    catch (error) {
                      if (error.code === 'ESRCH') await fs.rm(lock, { recursive: true, force: true });
                    }
                  }
                } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
                finally { if (recovering) await fs.rmdir(recovery); }
                continue;
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!acquired) throw new Error('Backup writer is busy; retry later (inspect .writer-lock if its owner file is missing)');
      return await callback();
    } finally {
      try { if (acquired) await fs.rm(lock, { recursive: true, force: true }); }
      finally { release(); }
    }
  }

  async select(sourceId) {
    const id = exactSourceId(sourceId);
    return this.locked(async () => {
      const current = await this.selected(id);
      if (!current) await immutableWrite(path.join(this.sourceRoot(id), 'selection.json'), canonical({ sourceId: id, schemaVersion: 1 }));
      await fs.mkdir(path.join(this.sourceRoot(id), 'records'), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(this.sourceRoot(id), 'blobs'), { recursive: true, mode: 0o700 });
      return { sourceId: id };
    });
  }

  async view(sourceId, { fresh = false } = {}) {
    const id = await this.assertSelected(sourceId);
    let state = fresh ? null : this.cache.get(id);
    if (!state) state = { seq: 0, head: null, latest: new Map(), records: [] };
    const directory = path.join(this.sourceRoot(id), 'records');
    const names = (await fs.readdir(directory)).filter(isRecord).sort();
    if (names.length < state.seq) throw new Error('Archive journal was truncated');
    // Concurrent readers load into independent projections; a status read must
    // not advance the writer's sequence halfway through another read.
    if (names.length > state.seq) state = { ...state, latest: new Map(state.latest), records: [...state.records] };
    for (const name of names.slice(state.seq)) {
      const bytes = await fs.readFile(path.join(directory, name));
      const record = JSON.parse(bytes);
      const digest = hash(bytes);
      if (name !== recordName(record.seq, digest) || record.seq !== state.seq + 1
        || record.previous !== state.head || record.schemaVersion !== 1 || record.sourceId !== id) {
        throw new Error(`Archive journal integrity failure: ${name}`);
      }
      state.seq = record.seq;
      state.head = digest;
      state.latest.set(`${record.kind}:${record.key}`, record);
      state.records.push({ ...record, file: name, digest });
    }
    if (!this.cache.has(id) || this.cache.get(id).seq <= state.seq) this.cache.set(id, state);
    return state;
  }

  async append(sourceId, entries) {
    if (!entries.length) return;
    return this.locked(async () => {
      const state = await this.view(sourceId);
      await this.ensureSpace(Buffer.byteLength(canonical(entries)));
      for (const { kind, key, payload, ifAbsent = false } of entries) {
        const previous = state.latest.get(`${kind}:${key}`);
        if (previous && ifAbsent) continue;
        if (previous && canonical(previous.payload) === canonical(payload)) continue;
        const record = {
          schemaVersion: 1, sourceId: String(sourceId), seq: state.seq + 1,
          previous: state.head, observedAt: new Date().toISOString(), kind, key: String(key), payload
        };
        const bytes = canonical(record);
        const digest = hash(bytes);
        const name = recordName(record.seq, digest);
        await immutableWrite(path.join(this.sourceRoot(sourceId), 'records', name), bytes);
        const committed = JSON.parse(bytes);
        state.seq = record.seq;
        state.head = digest;
        state.latest.set(`${kind}:${key}`, committed);
        state.records.push({ ...committed, file: name, digest });
      }
      return { seq: state.seq, head: state.head };
    });
  }

  blobPath(sourceId, digest) {
    if (!isHash(digest)) throw new Error('Invalid archive blob hash');
    return path.join(this.sourceRoot(sourceId), 'blobs', digest);
  }

  async saveBlob(sourceId, temporaryFile) {
    await this.assertSelected(sourceId);
    const size = (await fs.stat(temporaryFile)).size;
    if (!size) throw new Error('Empty archive media');
    const digest = await fileHash(temporaryFile);
    const target = this.blobPath(sourceId, digest);
    const handle = await fs.open(temporaryFile, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temporaryFile, target); await syncDirectory(path.dirname(target)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await fileHash(target) !== digest) throw new Error('Existing archive blob is corrupt');
    }
    return { sha256: digest, size };
  }

  async verify(sourceId, { readOnly = false } = {}) {
    const check = async () => {
      const state = await this.view(sourceId, { fresh: true });
      const blobs = new Map();
      for (const record of state.records) {
        if (['media', 'cached_media'].includes(record.kind) && record.payload.status === 'saved') {
          blobs.set(record.payload.sha256, record.payload.size);
        }
      }
      let bytes = 0;
      for (const [digest, size] of blobs) {
        const file = this.blobPath(sourceId, digest);
        if ((await fs.stat(file)).size !== size || await fileHash(file) !== digest) throw new Error(`Archive blob integrity failure: ${digest}`);
        bytes += size;
      }
      return { status: 'verified', sourceId: String(sourceId), records: state.seq, head: state.head, blobs: blobs.size, bytes };
    };
    return readOnly ? check() : this.locked(check);
  }
}
