import fs from 'node:fs/promises';

export function backupOpenApiPaths(config) {
  if (!config.appAuthToken) return {};
  const paths = {};
  const source = { name: 'sourceId', in: 'path', required: true, schema: { type: 'string', pattern: '^-?\\d{1,24}$' } };
  for (const [suffix, method, summary] of [
    ['', 'get', 'Permanent local chat backup status'], ['/enable', 'post', 'Enable backup for this exact chat'],
    ['/pause', 'post', 'Pause collection without deleting stored data'], ['/run', 'post', 'Collect bounded history pages and originals'],
    ['/verify', 'post', 'Verify local journal and media checksums'], ['/replicate', 'post', 'Create a verified snapshot at the configured second-copy destination'],
    ['/transcribe', 'post', 'Transcribe archived audio with an explicit bounded paid run'],
    ['/search', 'get', 'Search the local archive without Telegram'], ['/messages/{messageId}', 'get', 'Archived message context and versions'],
    ['/messages/{messageId}/media', 'get', 'Download archived media bytes']
  ]) {
    const parameters = [source];
    if (suffix.includes('{messageId}')) parameters.push({ name: 'messageId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } });
    if (suffix === '/search') parameters.push(
      { name: 'query', in: 'query', schema: { type: 'string', maxLength: 2000 } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
      { name: 'beforeMessageId', in: 'query', schema: { type: 'integer', minimum: 1 } }
    );
    if (suffix.endsWith('/media')) parameters.push({ name: 'version', in: 'query', schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
    paths[`/admin/backups/{sourceId}${suffix}`] = { [method]: {
      summary, operationId: `backup_${method}_${suffix.replace(/\W/g, '_') || 'status'}`, parameters, security: [{ bearerAuth: [] }],
      ...(['/run', '/transcribe'].includes(suffix) ? { requestBody: { content: { 'application/json': { schema: {
        type: 'object', properties: suffix === '/run' ? { pages: { type: 'integer', minimum: 1, maximum: 100, default: 5 } }
          : { limit: { type: 'integer', minimum: 1, maximum: 20, default: 1 } }
      } } } } } : {}),
      responses: { 200: { description: suffix.endsWith('/media') ? 'Original file, or explicitly labelled legacy cache fallback.' : 'Backup operation result.' }, 401: { description: 'Owner bearer token required.' } }
    } };
  }
  return paths;
}

export function registerBackupRoutes(app, { backup, auth, enabled }) {
  if (!enabled || !backup) return;
  const base = '/admin/backups/:sourceId';
  const wrap = (operation) => async (req, res, next) => {
    try { res.json(await operation(req)); } catch (error) { next(error); }
  };
  app.get(base, auth, wrap((req) => backup.status(req.params.sourceId)));
  app.post(`${base}/enable`, auth, wrap((req) => backup.enable(req.params.sourceId)));
  app.post(`${base}/pause`, auth, wrap((req) => backup.pause(req.params.sourceId)));
  app.post(`${base}/run`, auth, wrap((req) => backup.run(req.params.sourceId, { pages: req.body?.pages })));
  app.post(`${base}/verify`, auth, wrap((req) => backup.verify(req.params.sourceId)));
  // Destination is configured server-side; HTTP callers cannot write arbitrary paths.
  app.post(`${base}/replicate`, auth, wrap((req) => backup.replicate(req.params.sourceId)));
  app.post(`${base}/transcribe`, auth, wrap((req) => backup.transcribe({ sourceId: req.params.sourceId, limit: req.body?.limit })));
  app.get(`${base}/search`, auth, wrap((req) => backup.search({ sourceId: req.params.sourceId,
    query: req.query.query || '', limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
    beforeMessageId: req.query.beforeMessageId === undefined ? undefined : Number(req.query.beforeMessageId) })));
  app.get(`${base}/messages/:messageId`, auth, wrap((req) => backup.context({ sourceId: req.params.sourceId, messageId: Number(req.params.messageId) })));
  app.get(`${base}/messages/:messageId/media`, auth, async (req, res, next) => {
    try {
      const item = await backup.mediaFile({ sourceId: req.params.sourceId, messageId: Number(req.params.messageId), version: req.query.version });
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      // Force a download rather than executing arbitrary archived HTML/documents.
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', `attachment; filename="${item.messageId}-${item.sha256}"`);
      res.sendFile(item.filePath);
    } catch (error) { next(error); }
  });
}

export async function backupMediaResult(backup, args, maxBytes) {
  const item = await backup.mediaFile(args);
  const { filePath, ...metadata } = item;
  if (item.size > maxBytes) return { content: [{ type: 'text', text: JSON.stringify({ ...metadata, delivery: 'too_large_for_mcp', use: 'Authenticated admin download or CLI backup-media' }) }], structuredContent: metadata };
  const mime = item.media.mimeType;
  const type = ['image/jpeg', 'image/png', 'image/webp'].includes(mime) ? 'image'
    : ['audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/mp4', 'audio/webm', 'audio/flac', 'audio/aac', 'audio/opus'].includes(mime) ? 'audio' : null;
  const content = [{ type: 'text', text: JSON.stringify(metadata) }];
  if (type) content.push({ type, mimeType: mime, data: (await fs.readFile(filePath)).toString('base64') });
  return { content, structuredContent: metadata };
}
