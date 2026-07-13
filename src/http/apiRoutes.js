import {
  parseActionItemsQuery,
  parseAudioTranscriptionStatusQuery,
  parseDailyDigestQuery,
  parseMessageContextQuery,
  parsePeriodSummaryQuery,
  parseSearchQuery,
  parseSourceSummaryQuery,
  parseSyncStatusQuery,
  parseSourcesQuery
} from './query.js';

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

export function registerApiRoutes(app, { config, digestService, auth }) {
  const basePath = config.restBasePath;

  app.get(`${basePath}/sources`, auth, asyncHandler(async (req, res) => {
    res.json(await digestService.listSources(parseSourcesQuery(req.query)));
  }));

  app.get(`${basePath}/sync/status`, auth, asyncHandler(async (req, res) => {
    res.json(await digestService.getSyncStatus(parseSyncStatusQuery(req.query)));
  }));

  app.get(`${basePath}/transcriptions/status`, auth, asyncHandler(async (req, res) => {
    res.json(await digestService.getAudioTranscriptionStatus(parseAudioTranscriptionStatusQuery(req.query)));
  }));

  app.get(`${basePath}/digest/daily`, auth, asyncHandler(async (req, res) => {
    res.json(await digestService.getDailyDigest(parseDailyDigestQuery(req.query)));
  }));

  app.get(`${basePath}/summary/period`, auth, asyncHandler(async (req, res) => {
    res.json(await digestService.getPeriodSummary(parsePeriodSummaryQuery(req.query)));
  }));

  app.get(`${basePath}/sources/:sourceId/summary`, auth, asyncHandler(async (req, res) => {
    res.json(await digestService.getSourceSummary(parseSourceSummaryQuery(req.query, req.params)));
  }));

  app.get(`${basePath}/search`, auth, asyncHandler(async (req, res) => {
    res.json(await digestService.searchMessages(parseSearchQuery(req.query)));
  }));

  app.get(`${basePath}/messages/context`, auth, asyncHandler(async (req, res) => {
    res.json(await digestService.getMessageContext(parseMessageContextQuery(req.query)));
  }));

  app.get(`${basePath}/actions`, auth, asyncHandler(async (req, res) => {
    res.json(await digestService.getActionItems(parseActionItemsQuery(req.query)));
  }));
}
