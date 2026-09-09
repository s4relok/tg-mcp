import { randomUUID } from 'node:crypto';

import { effectiveSourceSettings } from '../services/sourceManagement.js';
import { createAuthorizedTelegramClient, syncTelegramMessages } from './telegramSync.js';

function positiveInteger(value, name, { fallback, max }) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1 || (max && value > max)) {
    throw new Error(`${name} must be a positive integer${max ? ` no greater than ${max}` : ''}`);
  }
  return value;
}

function sumResults(results) {
  return results.reduce((summary, item) => {
    summary.sourceCount += item.sourceCount || 0;
    summary.messageCount += item.messageCount || 0;
    summary.audioMessageCount += item.audioMessageCount || 0;
    summary.imageMessageCount += item.imageMessageCount || 0;
    summary.sources.push(...(item.sources || []));
    return summary;
  }, {
    sourceCount: 0,
    messageCount: 0,
    audioMessageCount: 0,
    imageMessageCount: 0,
    sources: []
  });
}

export function createTelegramSyncCoordinator({
  config,
  store,
  logger = console,
  createClient = createAuthorizedTelegramClient,
  syncMessages = syncTelegramMessages,
  imageService,
  afterSync,
  now = () => new Date()
}) {
  async function resolveCandidates({ sourceIds, dueOnly }) {
    if (dueOnly) {
      return store.listSourcesDueForSync({
        now: now(),
        limit: config.sourceSchedulerBatchSize || 10,
        defaultPriority: config.sourceDefaultPriority ?? 50
      });
    }

    const ids = [...new Set((sourceIds || []).map(String))];
    if (ids.length) {
      return store.listSources({ includeDisabled: true, sourceIds: ids });
    }
    return store.listSources();
  }

  async function run({
    sourceIds = [],
    limit,
    backfillDays,
    cacheImages = false,
    imageLimit,
    dueOnly = false,
    reason = dueOnly ? 'scheduler' : 'manual',
    actor = reason
  } = {}) {
    const operationId = randomUUID();
    const startedAt = now();
    const maxLimit = config.telegramSyncMaxLimit || 1000;
    const effectiveLimit = positiveInteger(limit, 'limit', {
      fallback: config.telegramSyncLimit,
      max: maxLimit
    });
    const requestedBackfillDays = backfillDays === undefined || backfillDays === null
      ? null
      : positiveInteger(backfillDays, 'backfillDays', { max: 3650 });
    const shouldCacheImages = !dueOnly && cacheImages === true;
    const effectiveImageLimit = shouldCacheImages
      ? positiveInteger(imageLimit, 'imageLimit', {
        fallback: config.mcpImageCacheMaxItemsPerSync || 100,
        max: config.mcpImageCacheMaxItemsPerSync || 100
      })
      : null;
    const requestedIds = [...new Set(sourceIds.map(String))];
    const candidates = await resolveCandidates({ sourceIds: requestedIds, dueOnly });
    const candidateById = new Map(candidates.map((source) => [source.sourceId, source]));
    const skipped = [];

    for (const sourceId of requestedIds) {
      if (!candidateById.has(sourceId)) {
        skipped.push({ sourceId, reason: 'not_found' });
      }
    }

    const ceiling = new Set((config.allowedSourceIds || []).map(String));
    const eligible = [];
    for (const source of candidates) {
      if (!source.enabled) {
        skipped.push({ sourceId: source.sourceId, title: source.title, reason: 'disabled' });
      } else if (ceiling.size && !ceiling.has(source.sourceId)) {
        skipped.push({ sourceId: source.sourceId, title: source.title, reason: 'outside_allowed_source_ids' });
      } else {
        eligible.push(source);
      }
    }

    const batchLimit = dueOnly
      ? config.sourceSchedulerBatchSize || 10
      : config.sourceMutationBatchLimit || 25;
    const boundedEligible = eligible.slice(0, batchLimit);
    for (const source of eligible.slice(batchLimit)) {
      skipped.push({ sourceId: source.sourceId, title: source.title, reason: 'batch_limit' });
    }

    let client = null;
    let clientError = null;
    const results = [];
    const imageCacheResults = [];
    const errors = [];

    async function telegramClient() {
      if (client) {
        return client;
      }
      if (clientError) {
        throw clientError;
      }
      try {
        client = await createClient(config);
        return client;
      } catch (caught) {
        clientError = caught;
        throw caught;
      }
    }

    try {
      for (const source of boundedEligible) {
        const attemptTime = now();
        const lockUntil = new Date(
          attemptTime.getTime() + (config.sourceSyncLockSeconds || 15 * 60) * 1000
        );
        const lockOwner = `${actor}:${operationId}`;
        const claimed = await store.claimSourceSync(source.sourceId, {
          now: attemptTime,
          lockUntil,
          owner: lockOwner
        });
        if (!claimed) {
          skipped.push({ sourceId: source.sourceId, title: source.title, reason: 'locked_or_disabled' });
          continue;
        }

        const { settings } = effectiveSourceSettings(claimed, config);
        const effectiveBackfillDays = requestedBackfillDays === null
          ? null
          : Math.min(requestedBackfillDays, settings.historyDepthDays);
        const minDate = effectiveBackfillDays === null
          ? undefined
          : new Date(attemptTime.getTime() - effectiveBackfillDays * 24 * 60 * 60 * 1000);
        const nextSyncAt = new Date(attemptTime.getTime() + settings.syncIntervalSeconds * 1000);

        try {
          const result = await syncMessages({
            client: await telegramClient(),
            store,
            config,
            sourceIds: [source.sourceId],
            limit: effectiveLimit,
            minDate,
            now: attemptTime
          });
          results.push(result);
          if (shouldCacheImages) {
            if (!imageService || typeof imageService.cacheSourceImages !== 'function') {
              imageCacheResults.push({
                status: 'error',
                sourceId: source.sourceId,
                requested: 0,
                cached: 0,
                alreadyCached: 0,
                failed: 1,
                error: 'Image cache service is not configured'
              });
            } else {
              try {
                imageCacheResults.push(await imageService.cacheSourceImages({
                  sourceId: source.sourceId,
                  client: await telegramClient(),
                  limit: effectiveImageLimit
                }));
              } catch (caught) {
                imageCacheResults.push({
                  status: 'error',
                  sourceId: source.sourceId,
                  requested: 0,
                  cached: 0,
                  alreadyCached: 0,
                  failed: 1,
                  error: caught instanceof Error ? caught.message : String(caught)
                });
              }
            }
          }
          await store.completeSourceSync(source.sourceId, {
            owner: lockOwner,
            now: now(),
            nextSyncAt,
            error: null
          });
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          errors.push({ sourceId: source.sourceId, title: source.title, error: message });
          await store.completeSourceSync(source.sourceId, {
            owner: lockOwner,
            now: now(),
            nextSyncAt,
            error: message
          });
          logger.warn(`Telegram source sync failed for ${source.sourceId}: ${message}`);
        }
      }
    } finally {
      if (client && typeof client.disconnect === 'function') {
        await client.disconnect();
      }
    }

    const summary = sumResults(results);
    let afterSyncResult = null;
    if (summary.audioMessageCount > 0 && afterSync) {
      try {
        afterSyncResult = await afterSync(summary);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.warn(`Post-sync processing skipped: ${message}`);
      }
    }

    return {
      operationId,
      status: errors.length ? (summary.sourceCount ? 'partial' : 'error') : 'ok',
      reason,
      startedAt: startedAt.toISOString(),
      completedAt: now().toISOString(),
      requestedBackfillDays,
      cacheImages: shouldCacheImages,
      imageLimit: effectiveImageLimit,
      imageCache: {
        requested: imageCacheResults.reduce((sum, item) => sum + (item.requested || 0), 0),
        cached: imageCacheResults.reduce((sum, item) => sum + (item.cached || 0), 0),
        alreadyCached: imageCacheResults.reduce(
          (sum, item) => sum + (item.alreadyCached || 0),
          0
        ),
        failed: imageCacheResults.reduce((sum, item) => sum + (item.failed || 0), 0),
        sources: imageCacheResults
      },
      afterSyncResult,
      ...summary,
      skipped,
      errors
    };
  }

  return {
    run,
    runDue: (args = {}) => run({ ...args, dueOnly: true, reason: 'scheduler' })
  };
}
