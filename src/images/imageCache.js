import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp']
]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function safeCachePath(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    return null;
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
}

async function removeFile(filePath) {
  if (!filePath) {
    return;
  }
  try {
    await fsp.rm(filePath, { force: true });
  } catch {
    // The cache record is still removed; a later orphan sweep can retry.
  }
}

async function listFilesRecursively(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else {
        files.push(entryPath);
      }
    }
  }
  await walk(root);
  return files;
}

export function createImageCache({
  config,
  store,
  logger = console,
  now = () => new Date()
}) {
  const root = path.resolve(config.imageCacheDir || './tmp/image-cache');
  const retentionDays = Math.min(30, Math.max(1, config.imageCacheRetentionDays || 30));
  const maxFileBytes = config.mcpImageMaxFileBytes || 10 * 1024 * 1024;
  const activeWrites = new Set();

  async function ensureRoot() {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fsp.chmod(root, 0o700);
    }
  }

  async function deleteEntry(entry) {
    const filePath = safeCachePath(root, entry?.relativePath);
    await removeFile(filePath);
    await store.deleteMediaCacheEntry({
      sourceId: entry.sourceId,
      messageId: entry.messageId
    });
  }

  async function getValidEntry(sourceId, messageId, { readData = true } = {}) {
    const [entry] = await store.getMediaCacheEntries({
      sourceId,
      messageIds: [messageId]
    });
    if (!entry) {
      return null;
    }
    if (new Date(entry.expiresAt) <= now()) {
      await deleteEntry(entry);
      return null;
    }
    if (!MIME_EXTENSIONS.has(entry.mimeType) || entry.size > maxFileBytes) {
      await deleteEntry(entry);
      return null;
    }
    const filePath = safeCachePath(root, entry.relativePath);
    if (!filePath) {
      await store.deleteMediaCacheEntry({ sourceId, messageId });
      return null;
    }

    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile() || stat.size !== entry.size || stat.size > maxFileBytes) {
        await deleteEntry(entry);
        return null;
      }
      if (!readData) {
        return { entry, filePath, buffer: null };
      }
      const buffer = await fsp.readFile(filePath);
      if (sha256(buffer) !== entry.sha256) {
        await deleteEntry(entry);
        return null;
      }
      return { entry, filePath, buffer };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`Image cache read failed for ${sourceId}/${messageId}: ${error.message}`);
      }
      await store.deleteMediaCacheEntry({ sourceId, messageId });
      return null;
    }
  }

  async function storeBuffer({ sourceId, messageId, mimeType, buffer }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('Image download produced an empty buffer');
    }
    const normalizedMimeType = String(mimeType || '').toLowerCase();
    const extension = MIME_EXTENSIONS.get(normalizedMimeType);
    if (!extension) {
      throw new Error(`Unsupported image MIME type: ${mimeType || 'unknown'}`);
    }
    if (buffer.length > maxFileBytes) {
      throw new Error(`Image exceeds the ${maxFileBytes} byte cache limit`);
    }

    await ensureRoot();
    const existing = (await store.getMediaCacheEntries({
      sourceId,
      messageIds: [messageId]
    }))[0] || null;
    const id = randomUUID().replaceAll('-', '');
    const relativePath = path.join(id.slice(0, 2), id.slice(2, 4), `${id}${extension}`);
    const filePath = safeCachePath(root, relativePath);
    const tempPath = `${filePath}.tmp-${randomUUID()}`;
    const digest = sha256(buffer);
    const cachedAt = now();
    const expiresAt = new Date(
      cachedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000
    );

    activeWrites.add(filePath);
    activeWrites.add(tempPath);
    try {
      await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await fsp.writeFile(tempPath, buffer, { mode: 0o600 });
      await fsp.rename(tempPath, filePath);
      const entry = await store.upsertMediaCache({
        sourceId,
        messageId,
        relativePath,
        mimeType: normalizedMimeType,
        size: buffer.length,
        sha256: digest,
        cachedAt,
        expiresAt
      });
      if (existing && existing.relativePath !== relativePath) {
        await removeFile(safeCachePath(root, existing.relativePath));
      }
      return entry;
    } catch (error) {
      await removeFile(tempPath);
      await removeFile(filePath);
      throw error;
    } finally {
      activeWrites.delete(filePath);
      activeWrites.delete(tempPath);
    }
  }

  async function cleanup({ batchLimit = 500 } = {}) {
    await ensureRoot();
    let expiredCount = 0;
    while (true) {
      const expired = await store.listExpiredMediaCache({
        now: now(),
        limit: batchLimit
      });
      if (!expired.length) {
        break;
      }
      for (const entry of expired) {
        await deleteEntry(entry);
        expiredCount += 1;
      }
      if (expired.length < batchLimit) {
        break;
      }
    }

    const entries = await store.listAllMediaCacheEntries();
    const knownFiles = new Set(
      entries
        .map((entry) => safeCachePath(root, entry.relativePath))
        .filter(Boolean)
    );
    let orphanCount = 0;
    const files = await listFilesRecursively(root);
    for (const filePath of files) {
      if (knownFiles.has(filePath) || activeWrites.has(filePath)) {
        continue;
      }
      if (filePath.includes('.tmp-')) {
        const stat = await fsp.stat(filePath);
        if (now().getTime() - stat.mtimeMs < 60 * 60 * 1000) {
          continue;
        }
      }
      await removeFile(filePath);
      orphanCount += 1;
    }

    return {
      expiredCount,
      orphanCount
    };
  }

  return {
    root,
    retentionDays,
    getValidEntry,
    storeBuffer,
    deleteEntry,
    cleanup
  };
}

export function startImageCacheJanitor({
  cache,
  config,
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let stopped = false;
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running) {
      return { skipped: true, reason: 'already_running' };
    }
    running = true;
    try {
      return await cache.cleanup();
    } catch (error) {
      logger.warn(`Image cache cleanup failed: ${error.message}`);
      return { error: error.message };
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (stopped) {
      return;
    }
    timer = setTimer(async () => {
      await runOnce();
      schedule();
    }, Math.max(60, config.imageCacheCleanupIntervalSeconds || 3600) * 1000);
  }

  void runOnce();
  schedule();

  return {
    runOnce,
    async stop() {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
    }
  };
}
