import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, hash } from './archiveStore.js';
import { stableIndexedContent } from './contentIdentity.js';

export async function indexFingerprint(store, sourceId) {
  const [source] = await store.listSources({ sourceIds: [sourceId] });
  if (!source) throw new Error('Daily backup requires an enabled source');
  const messages = [];
  for await (const message of store.iterateBackupMessages(sourceId)) {
    messages.push([message.messageId, hash(canonical(stableIndexedContent(JSON.parse(canonical(message)))))]);
  }
  messages.sort((a, b) => a[0] - b[0]);
  const supplemental = (await store.getBackupSupplemental(sourceId)).map((item) => hash(canonical(item))).sort();
  const cache = store.getMediaCacheEntries ? (await store.getMediaCacheEntries({ sourceId })).map((entry) =>
    canonical({ messageId: entry.messageId, sha256: entry.sha256, size: entry.size, mimeType: entry.mimeType })).sort() : [];
  return hash(canonical({ version: 1, source: { sourceId, title: source.title, username: source.username,
    type: source.type, settings: source.settings, tags: source.tags }, messages, supplemental, cache }));
}

export async function runDailyBackup({ backup, store, sourceId, now = new Date() }) {
  const id = await backup.archive.assertSelected(sourceId);
  const stateFile = path.join(backup.archive.sourceRoot(id), 'daily-state.json');
  let previous;
  try { previous = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fingerprint = await indexFingerprint(store, id);
  const state = await backup.archive.view(id);
  const incomplete = !state.latest.get('cursor:history')?.payload.complete;
  const retryDue = [...state.latest.values()].some((r) => r.kind === 'media'
    && ['pending', 'failed', 'blocked_by_limit'].includes(r.payload.status)
    && (!r.payload.retryAt || Date.parse(r.payload.retryAt) <= now.getTime()));
  if (previous?.fingerprint === fingerprint && !incomplete && !retryDue) {
    return { sourceId: id, status: 'unchanged', checkedAt: now.toISOString(), fingerprint };
  }
  // Update the single persistent archive in place. Do not create dated exports.
  const result = await backup.runOnce(id);
  const checked = await backup.archive.verify(id, { readOnly: true });
  const saved = { sourceId: id, fingerprint, completedAt: new Date().toISOString(), records: checked.records, head: checked.head };
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, canonical(saved), { mode: 0o600 });
  await fs.rename(temporary, stateFile);
  return { ...saved, status: 'updated', messages: result.messages, media: result.media, archive: result.localArchive };
}
