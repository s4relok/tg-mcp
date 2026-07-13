import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { BadRequestError, isHttpError } from './http/errors.js';
import { registerApiRoutes } from './http/apiRoutes.js';
import { requireAppToken } from './http/auth.js';
import { createOpenApiDocument } from './http/openapi.js';
import { createAudioTranscriptionWorker } from './audio/transcriptionWorker.js';
import { createTelegramMcpServer } from './mcp/server.js';
import { createReadinessReport } from './services/doctor.js';
import { selectSource } from './services/sourceAdmin.js';
import { createAuthorizedTelegramClient, refreshTelegramSources, syncTelegramMessages } from './telegram/telegramSync.js';

function toArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(toArray);
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toPositiveInteger(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new BadRequestError(`Expected positive integer, got ${value}`);
  }
  const parsed = Number.parseInt(text, 10);
  if (parsed < 1) {
    throw new BadRequestError(`Expected positive integer, got ${value}`);
  }
  return parsed;
}

function minDateFromBackfillDays(days, now = new Date()) {
  if (!days) {
    return undefined;
  }
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function publicSource(source) {
  return {
    sourceId: source.sourceId,
    title: source.title,
    username: source.username || null,
    type: source.type || 'unknown',
    enabled: source.enabled !== false,
    tags: source.tags || []
  };
}

async function sourceById(store, sourceId) {
  const [source] = await store.listSources({
    includeDisabled: true,
    sourceIds: [sourceId]
  });
  return source || null;
}

function jsonRpcError(res, status, message) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message
    },
    id: null
  });
}

export function createApp({ config, store, digestService, telegramAdmin = {}, audioTranscriptionAdmin = {} }) {
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: config.allowedHosts
  });
  const auth = requireAppToken(config);
  const transports = new Map();
  const createTelegramClient = telegramAdmin.createClient || createAuthorizedTelegramClient;
  const refreshSources = telegramAdmin.refreshSources || refreshTelegramSources;
  const syncMessages = telegramAdmin.syncMessages || syncTelegramMessages;
  const now = telegramAdmin.now || (() => new Date());
  const allowRequest = (_req, _res, next) => next();
  const runAudioTranscriptions = audioTranscriptionAdmin.runOnce || (async (args = {}) => {
    const worker = createAudioTranscriptionWorker({
      config,
      store,
      logger: audioTranscriptionAdmin.logger || console,
      createClient: audioTranscriptionAdmin.createClient || createTelegramClient,
      createTranscriber: audioTranscriptionAdmin.createTranscriber,
      getMessage: audioTranscriptionAdmin.getMessage,
      downloadAudio: audioTranscriptionAdmin.downloadAudio,
      now: audioTranscriptionAdmin.now || now
    });
    return worker.runOnce({ ...args, force: args.force ?? true });
  });

  app.get('/health', async (_req, res) => {
    try {
      const storage = await store.health();
      res.json({
        status: 'ok',
        name: 'tg-mcp',
        storage,
        mcpPath: config.mcpPath,
        chatGptMcpPath: config.chatGptMcpPath || null,
        restBasePath: config.restBasePath,
        openApiPath: config.openApiPath
      });
    } catch (error) {
      res.status(503).json({
        status: 'error',
        error: error.message
      });
    }
  });

  app.get('/admin/sources', auth, async (_req, res, next) => {
    try {
      res.json(await digestService.listSources({ includeDisabled: true }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/sources/refresh', auth, async (_req, res, next) => {
    let client = null;
    try {
      client = await createTelegramClient(config);
      const result = await refreshSources({
        client,
        store,
        config
      });
      res.json({
        status: 'ok',
        ...result
      });
    } catch (caught) {
      next(caught);
    } finally {
      if (client?.disconnect) {
        await client.disconnect();
      }
    }
  });

  app.post('/admin/sources/select', auth, async (req, res, next) => {
    try {
      if (!String(req.body?.query || '').trim()) {
        throw new BadRequestError('query is required');
      }
      const result = await selectSource(store, {
        query: String(req.body?.query || ''),
        tags: toArray(req.body?.tags ?? req.body?.tag)
      });
      const status = result.status === 'selected'
        ? 200
        : result.status === 'not_found'
          ? 404
          : 409;
      res.status(status).json(result);
    } catch (caught) {
      next(caught);
    }
  });

  app.post('/admin/sources/:sourceId/enable', auth, async (req, res, next) => {
    try {
      const source = await store.setSourceEnabled(req.params.sourceId, true);
      if (!source) {
        res.status(404).json({ status: 'not_found', sourceId: req.params.sourceId });
        return;
      }

      const tags = toArray(req.body?.tags ?? req.body?.tag);
      if (tags.length) {
        await store.setSourceTags(req.params.sourceId, tags);
      }

      const updated = await sourceById(store, req.params.sourceId);
      res.json({
        status: 'enabled',
        source: publicSource(updated || source)
      });
    } catch (caught) {
      next(caught);
    }
  });

  app.post('/admin/sources/:sourceId/disable', auth, async (req, res, next) => {
    try {
      const source = await store.setSourceEnabled(req.params.sourceId, false);
      if (!source) {
        res.status(404).json({ status: 'not_found', sourceId: req.params.sourceId });
        return;
      }

      const updated = await sourceById(store, req.params.sourceId);
      res.json({
        status: 'disabled',
        source: publicSource(updated || source)
      });
    } catch (caught) {
      next(caught);
    }
  });

  app.post('/admin/sources/:sourceId/tags', auth, async (req, res, next) => {
    try {
      const source = await store.setSourceTags(req.params.sourceId, toArray(req.body?.tags ?? req.body?.tag));
      if (!source) {
        res.status(404).json({ status: 'not_found', sourceId: req.params.sourceId });
        return;
      }

      const updated = await sourceById(store, req.params.sourceId);
      res.json({
        status: 'tagged',
        source: publicSource(updated || source)
      });
    } catch (caught) {
      next(caught);
    }
  });

  app.get('/admin/doctor', auth, async (req, res, next) => {
    try {
      const report = await createReadinessReport({
        config,
        store,
        checkTelegram: req.query.telegram === 'true'
      });
      res.status(report.status === 'error' ? 503 : 200).json(report);
    } catch (caught) {
      next(caught);
    }
  });

  app.post('/admin/sync', auth, async (req, res, next) => {
    let client = null;
    try {
      const body = req.body || {};
      const backfillDays = toPositiveInteger(body.backfillDays);
      client = await createTelegramClient(config);
      const result = await syncMessages({
        client,
        store,
        config,
        sourceIds: toArray(body.sourceIds ?? body.sourceId),
        limit: toPositiveInteger(body.limit),
        minDate: minDateFromBackfillDays(backfillDays, now())
      });
      const audioTranscription = result.audioMessageCount > 0
        ? await runAudioTranscriptions({
          limit: config.audioTranscriptionBatchSize,
          force: false
        })
        : null;

      res.json({
        status: 'ok',
        backfillDays: backfillDays || null,
        audioTranscription,
        ...result
      });
    } catch (caught) {
      next(caught);
    } finally {
      if (client?.disconnect) {
        await client.disconnect();
      }
    }
  });

  app.get('/admin/transcriptions/status', auth, async (req, res, next) => {
    try {
      res.json(await store.getAudioTranscriptionStatus({
        sourceIds: toArray(req.query.sourceIds ?? req.query.sourceId)
      }));
    } catch (caught) {
      next(caught);
    }
  });

  app.post('/admin/transcriptions/run', auth, async (req, res, next) => {
    try {
      const body = req.body || {};
      const result = await runAudioTranscriptions({
        sourceIds: toArray(body.sourceIds ?? body.sourceId),
        limit: toPositiveInteger(body.limit)
      });
      res.json({
        status: result.error ? 'error' : 'ok',
        ...result
      });
    } catch (caught) {
      next(caught);
    }
  });

  app.post('/admin/transcriptions/retry-failed', auth, async (req, res, next) => {
    try {
      const body = req.body || {};
      res.json({
        status: 'ok',
        ...(await store.resetFailedAudioTranscriptions({
          sourceIds: toArray(body.sourceIds ?? body.sourceId),
          limit: toPositiveInteger(body.limit)
        }))
      });
    } catch (caught) {
      next(caught);
    }
  });

  app.get(config.openApiPath, (_req, res) => {
    res.json(createOpenApiDocument(config));
  });

  registerApiRoutes(app, { config, digestService, auth });

  function registerMcpRoutes(routePath, routeAuth) {
    app.post(routePath, routeAuth, async (req, res) => {
      const sessionId = req.get('mcp-session-id');

      try {
        if (sessionId && transports.has(sessionId)) {
          await transports.get(sessionId).transport.handleRequest(req, res, req.body);
          return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
          const mcpServer = createTelegramMcpServer({ digestService, config });
          let generatedSessionId = null;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              generatedSessionId = newSessionId;
              transports.set(newSessionId, { transport, mcpServer });
            }
          });

          transport.onclose = async () => {
            const id = generatedSessionId || transport.sessionId;
            if (id) {
              transports.delete(id);
            }
            await mcpServer.close();
          };

          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }

        jsonRpcError(res, 400, 'Bad Request: missing or invalid MCP session.');
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          jsonRpcError(res, 500, 'Internal server error.');
        }
      }
    });

    app.get(routePath, routeAuth, async (req, res) => {
      const sessionId = req.get('mcp-session-id');
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).send('Invalid or missing MCP session id.');
        return;
      }

      await transports.get(sessionId).transport.handleRequest(req, res);
    });

    app.delete(routePath, routeAuth, async (req, res) => {
      const sessionId = req.get('mcp-session-id');
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).send('Invalid or missing MCP session id.');
        return;
      }

      await transports.get(sessionId).transport.handleRequest(req, res);
    });
  }

  registerMcpRoutes(config.mcpPath, auth);
  if (config.chatGptMcpPath && config.chatGptMcpPath !== config.mcpPath) {
    registerMcpRoutes(config.chatGptMcpPath, allowRequest);
  }

  app.use((error, _req, res, _next) => {
    if (isHttpError(error)) {
      res.status(error.statusCode).json({
        error: error.code,
        message: error.message
      });
      return;
    }

    console.error(error);
    res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}
