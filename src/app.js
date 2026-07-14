import { randomUUID } from 'node:crypto';

import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { BadRequestError, isHttpError } from './http/errors.js';
import { registerApiRoutes } from './http/apiRoutes.js';
import { requireAppToken } from './http/auth.js';
import {
  createOAuthBearerAuth,
  createProtectedResourceMetadata,
  oauthSessionPrincipal
} from './http/oauth.js';
import { createOpenApiDocument } from './http/openapi.js';
import { createAudioTranscriptionWorker } from './audio/transcriptionWorker.js';
import { createTelegramMcpServer } from './mcp/server.js';
import { createReadinessReport } from './services/doctor.js';
import {
  createSourceManagementService,
  SourceManagementError
} from './services/sourceManagement.js';
import { selectSource } from './services/sourceAdmin.js';
import { createTelegramSyncCoordinator } from './telegram/sourceSyncCoordinator.js';
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

function sourceSettingsFromBody(body = {}) {
  if (body.settings) {
    return body.settings;
  }
  const settings = {};
  for (const key of [
    'syncIntervalSeconds',
    'historyDepthDays',
    'includeMedia',
    'includeReplies',
    'includeForwardedPosts',
    'priority'
  ]) {
    if (Object.hasOwn(body, key)) {
      settings[key] = body[key];
    }
  }
  return settings;
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

export function createApp({
  config,
  store,
  digestService,
  sourceManagementService,
  syncCoordinator,
  oauthTokenVerifier,
  telegramAdmin = {},
  audioTranscriptionAdmin = {}
}) {
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: config.allowedHosts
  });
  const auth = requireAppToken(config);
  const oauthAuth = config.oauthEnabled
    ? createOAuthBearerAuth(config, { verifier: oauthTokenVerifier })
    : null;
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
  const manageSources = sourceManagementService || createSourceManagementService({ store, config, now });
  const sourceSync = syncCoordinator || createTelegramSyncCoordinator({
    config,
    store,
    createClient: createTelegramClient,
    syncMessages,
    now,
    afterSync: async (result) => {
      if (result.audioMessageCount > 0) {
        return runAudioTranscriptions({
          limit: config.audioTranscriptionBatchSize,
          force: false
        });
      }
      return null;
    }
  });

  if (config.oauthEnabled) {
    const metadata = createProtectedResourceMetadata(config);
    const pathSpecificMetadataPath = new URL(config.oauthProtectedResourceMetadataUrl).pathname;
    app.use(pathSpecificMetadataPath, metadataHandler(metadata));
    if (pathSpecificMetadataPath !== '/.well-known/oauth-protected-resource') {
      app.use('/.well-known/oauth-protected-resource', metadataHandler(metadata));
    }
  }

  app.get('/health', async (_req, res) => {
    try {
      const storage = await store.health();
      res.json({
        status: 'ok',
        name: 'tg-mcp',
        storage,
        mcpPath: config.mcpPath,
        chatGptMcpPath: config.chatGptMcpPath || null,
        oauthMcpPath: config.oauthEnabled ? config.oauthMcpPath : null,
        oauthResource: config.oauthEnabled ? config.oauthResource : null,
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
        tags: toArray(req.body?.tags ?? req.body?.tag),
        actor: 'admin',
        sourceManagementService: manageSources
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
      const result = await manageSources.enableSources({
        sourceIds: [req.params.sourceId],
        tags: toArray(req.body?.tags ?? req.body?.tag),
        tagMode: 'add',
        confirmSensitive: true,
        actor: 'admin'
      });
      if (result.status === 'not_found') {
        res.status(404).json({ status: 'not_found', sourceId: req.params.sourceId });
        return;
      }
      res.json({
        status: 'enabled',
        source: result.sources[0]
      });
    } catch (caught) {
      next(caught);
    }
  });

  app.post('/admin/sources/:sourceId/disable', auth, async (req, res, next) => {
    try {
      const result = await manageSources.disableSources({
        sourceIds: [req.params.sourceId],
        actor: 'admin'
      });
      if (result.status === 'not_found') {
        res.status(404).json({ status: 'not_found', sourceId: req.params.sourceId });
        return;
      }
      res.json({
        status: 'disabled',
        source: result.sources[0]
      });
    } catch (caught) {
      next(caught);
    }
  });

  app.post('/admin/sources/:sourceId/tags', auth, async (req, res, next) => {
    try {
      const result = await manageSources.setSourceTags({
        sourceIds: [req.params.sourceId],
        tags: toArray(req.body?.tags ?? req.body?.tag),
        tagMode: req.body?.mode || 'replace',
        actor: 'admin'
      });
      if (result.status === 'not_found') {
        res.status(404).json({ status: 'not_found', sourceId: req.params.sourceId });
        return;
      }
      res.json({
        status: 'tagged',
        source: result.sources[0]
      });
    } catch (caught) {
      next(caught);
    }
  });

  app.get('/admin/sources/:sourceId/settings', auth, async (req, res, next) => {
    try {
      const result = await manageSources.getSourceSettings(req.params.sourceId);
      res.status(result.status === 'not_found' ? 404 : 200).json(result);
    } catch (caught) {
      next(caught);
    }
  });

  app.patch('/admin/sources/:sourceId/settings', auth, async (req, res, next) => {
    try {
      const result = await manageSources.updateSourceSettings({
        sourceId: req.params.sourceId,
        settings: sourceSettingsFromBody(req.body || {}),
        expectedVersion: req.body?.expectedVersion,
        preview: Boolean(req.body?.preview),
        actor: 'admin'
      });
      const status = result.status === 'not_found' ? 404 : result.status === 'conflict' ? 409 : 200;
      res.status(status).json(result);
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
    try {
      const body = req.body || {};
      const backfillDays = toPositiveInteger(body.backfillDays);
      const result = await sourceSync.run({
        sourceIds: toArray(body.sourceIds ?? body.sourceId),
        limit: toPositiveInteger(body.limit),
        backfillDays,
        reason: 'admin',
        actor: 'admin'
      });

      res.json({
        status: result.status,
        backfillDays: backfillDays || null,
        audioTranscription: result.afterSyncResult,
        ...result
      });
    } catch (caught) {
      next(caught);
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

  function registerMcpRoutes(routePath, routeAuth, access = {}) {
    const getSession = (sessionId, req) => {
      if (!sessionId || !transports.has(sessionId)) {
        return null;
      }
      const session = transports.get(sessionId);
      if (session.routePath !== routePath) {
        return null;
      }
      if (access.oauth && session.principal !== oauthSessionPrincipal(req.auth)) {
        return null;
      }
      return session;
    };

    app.post(routePath, routeAuth, async (req, res) => {
      const sessionId = req.get('mcp-session-id');

      try {
        const session = getSession(sessionId, req);
        if (session) {
          await session.transport.handleRequest(req, res, req.body);
          return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
          const mcpServer = createTelegramMcpServer({
            digestService,
            config,
            sourceManagementService: manageSources,
            syncCoordinator: sourceSync,
            access
          });
          let generatedSessionId = null;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              generatedSessionId = newSessionId;
              transports.set(newSessionId, {
                transport,
                mcpServer,
                routePath,
                principal: access.oauth ? oauthSessionPrincipal(req.auth) : ''
              });
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
      const session = getSession(sessionId, req);
      if (!session) {
        res.status(400).send('Invalid or missing MCP session id.');
        return;
      }

      await session.transport.handleRequest(req, res);
    });

    app.delete(routePath, routeAuth, async (req, res) => {
      const sessionId = req.get('mcp-session-id');
      const session = getSession(sessionId, req);
      if (!session) {
        res.status(400).send('Invalid or missing MCP session id.');
        return;
      }

      await session.transport.handleRequest(req, res);
    });
  }

  const hasOwnerToken = Boolean(config.appAuthToken);
  registerMcpRoutes(config.mcpPath, auth, {
    allowDisabledSources: hasOwnerToken,
    manageSources: hasOwnerToken && config.mcpSourceManagementEnabled,
    runSourceSync: hasOwnerToken && config.mcpSourceManagementEnabled,
    actor: 'mcp:owner-token'
  });
  if (config.chatGptMcpPath && config.chatGptMcpPath !== config.mcpPath) {
    registerMcpRoutes(config.chatGptMcpPath, allowRequest, {
      allowDisabledSources: false,
      manageSources: false,
      runSourceSync: false,
      actor: 'mcp:read-only'
    });
  }
  if (config.oauthEnabled) {
    registerMcpRoutes(config.oauthMcpPath, oauthAuth, {
      oauth: true,
      allowDisabledSources: config.mcpSourceManagementEnabled,
      manageSources: config.mcpSourceManagementEnabled,
      runSourceSync: config.mcpSourceManagementEnabled,
      actor: 'mcp:oauth'
    });
  }

  app.use((error, _req, res, _next) => {
    if (error instanceof SourceManagementError) {
      res.status(400).json({
        error: error.code,
        message: error.message,
        details: error.details
      });
      return;
    }
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
