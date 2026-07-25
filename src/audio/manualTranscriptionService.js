import { resolveEligibleSource } from '../services/sourceAccess.js';

function boundedLimit(value, maximum) {
  const limit = value === undefined || value === null ? 1 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`limit must be an integer between 1 and ${maximum}`);
  }
  return limit;
}

export function createManualTranscriptionService({
  config,
  store,
  runAudioTranscriptions
}) {
  if (typeof runAudioTranscriptions !== 'function') {
    throw new Error('runAudioTranscriptions is required');
  }

  return {
    async transcribeSourceAudio({ sourceId, limit } = {}) {
      const eligibility = await resolveEligibleSource({ store, config, sourceId });
      if (!eligibility.eligible) {
        return {
          status: 'rejected',
          sourceId: eligibility.sourceId,
          reason: eligibility.reason,
          message: eligibility.message
        };
      }

      const requestedLimit = boundedLimit(
        limit,
        config.mcpManualTranscriptionMaxLimit || 10
      );
      const result = await runAudioTranscriptions({
        sourceIds: [eligibility.sourceId],
        limit: requestedLimit,
        force: true
      });
      const transcriptionStatus = await store.getAudioTranscriptionStatus({
        sourceIds: [eligibility.sourceId]
      });
      const processedCount = result.processedCount || 0;
      const hint = processedCount === 0
        ? 'No pending audio was processed. Call sync_source first when fresh or historical Telegram audio is needed.'
        : null;

      return {
        status: result.error ? 'error' : (result.skipped ? 'skipped' : 'ok'),
        sourceId: eligibility.sourceId,
        sourceTitle: eligibility.source.title,
        requestedLimit,
        processedCount,
        completed: result.completed || 0,
        failed: result.failed || 0,
        retryScheduled: result.retryScheduled || 0,
        remainingPending: transcriptionStatus.counts.pending || 0,
        reason: result.reason || null,
        error: result.error || null,
        results: result.results || [],
        hint
      };
    }
  };
}
