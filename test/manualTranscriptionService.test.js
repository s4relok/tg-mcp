import assert from 'node:assert/strict';
import test from 'node:test';

import { createManualTranscriptionService } from '../src/audio/manualTranscriptionService.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function pendingAudio(sourceId, messageId) {
  return {
    sourceId,
    messageId,
    date: '2026-07-25T10:00:00.000Z',
    text: '',
    transcriptText: '',
    media: { kind: 'voice', mimeType: 'audio/ogg' },
    transcription: { status: 'pending', attempts: 0 }
  };
}

test('manual transcription targets one exact source without changing the background allowlist', async () => {
  const config = {
    allowedSourceIds: [],
    audioTranscriptionSourceIds: ['saved'],
    mcpManualTranscriptionMaxLimit: 10
  };
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'saved', title: 'Saved Messages', enabled: true },
      { sourceId: 'work', title: 'Work Chat', enabled: true }
    ],
    messages: [
      pendingAudio('work', 11),
      pendingAudio('saved', 12)
    ]
  });
  let runArgs = null;
  const service = createManualTranscriptionService({
    config,
    store,
    runAudioTranscriptions: async (args) => {
      runArgs = args;
      await store.completeAudioTranscription({
        sourceId: 'work',
        messageId: 11,
        transcriptText: 'Manual work transcript'
      });
      return {
        processedCount: 1,
        completed: 1,
        failed: 0,
        retryScheduled: 0,
        results: [{ sourceId: 'work', messageId: 11, status: 'done' }]
      };
    }
  });

  const result = await service.transcribeSourceAudio({
    sourceId: 'work',
    limit: 3
  });

  assert.deepEqual(runArgs, {
    sourceIds: ['work'],
    limit: 3,
    force: true
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.completed, 1);
  assert.equal(result.remainingPending, 0);
  assert.deepEqual(config.audioTranscriptionSourceIds, ['saved']);
  const savedStatus = await store.getAudioTranscriptionStatus({ sourceIds: ['saved'] });
  assert.equal(savedStatus.counts.pending, 1);
});

test('manual transcription rejects disabled, missing, and outside-ceiling sources before running', async () => {
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'disabled', title: 'Disabled', enabled: false },
      { sourceId: 'outside', title: 'Outside', enabled: true }
    ]
  });
  let runs = 0;
  const service = createManualTranscriptionService({
    config: {
      allowedSourceIds: ['allowed'],
      mcpManualTranscriptionMaxLimit: 10
    },
    store,
    runAudioTranscriptions: async () => {
      runs += 1;
      return {};
    }
  });

  for (const [sourceId, reason] of [
    ['missing', 'not_found'],
    ['disabled', 'disabled'],
    ['outside', 'outside_allowed_source_ids']
  ]) {
    const result = await service.transcribeSourceAudio({ sourceId });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, reason);
  }
  assert.equal(runs, 0);
});

test('manual transcription returns a sync hint when no pending audio is available', async () => {
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'work', title: 'Work Chat', enabled: true }]
  });
  const service = createManualTranscriptionService({
    config: { allowedSourceIds: [], mcpManualTranscriptionMaxLimit: 10 },
    store,
    runAudioTranscriptions: async () => ({
      processedCount: 0,
      completed: 0,
      failed: 0,
      retryScheduled: 0,
      results: []
    })
  });

  const result = await service.transcribeSourceAudio({ sourceId: 'work' });

  assert.equal(result.status, 'ok');
  assert.equal(result.requestedLimit, 1);
  assert.equal(result.processedCount, 0);
  assert.match(result.hint, /sync_source/);
});

test('manual transcription rejects limits outside the configured server ceiling', async () => {
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'work', title: 'Work Chat', enabled: true }]
  });
  let runs = 0;
  const service = createManualTranscriptionService({
    config: {
      allowedSourceIds: [],
      mcpManualTranscriptionMaxLimit: 3
    },
    store,
    runAudioTranscriptions: async () => {
      runs += 1;
      return {};
    }
  });

  for (const limit of [0, 4, 1.5]) {
    await assert.rejects(
      service.transcribeSourceAudio({ sourceId: 'work', limit }),
      /limit must be an integer between 1 and 3/
    );
  }
  assert.equal(runs, 0);
});
