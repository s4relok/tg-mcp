import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAudioTranscriptionWorker } from '../src/audio/transcriptionWorker.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function baseConfig(overrides = {}) {
  return {
    openAiApiKey: 'test-key',
    openAiTranscriptionEnabled: true,
    openAiTranscriptionModel: 'gpt-4o-transcribe',
    openAiTranscriptionResponseFormat: 'json',
    openAiTranscriptionPrompt: '',
    openAiTranscriptionLanguage: '',
    openAiTranscriptionChunkingStrategy: '',
    audioTranscriptionSourceIds: ['saved'],
    audioTranscriptionSourceTags: [],
    audioTranscriptionBatchSize: 1,
    audioTranscriptionIntervalSeconds: 3600,
    audioTranscriptionLockMs: 600000,
    audioTranscriptionMaxAttempts: 2,
    audioTranscriptionWorkDir: '',
    audioTranscriptionMaxFileBytes: 25 * 1024 * 1024,
    audioTranscriptionSplitLargeFiles: true,
    ffmpegPath: 'ffmpeg',
    ...overrides
  };
}

function storeWithPendingAudio() {
  return new MemoryTelegramStore({
    sources: [{ sourceId: 'saved', title: 'Saved Messages', enabled: true, tags: [] }],
    messages: [
      {
        sourceId: 'saved',
        sourceTitle: 'Saved Messages',
        messageId: 101,
        date: '2026-07-09T09:00:00.000Z',
        text: '',
        transcriptText: '',
        media: {
          kind: 'voice',
          mimeType: 'audio/ogg',
          durationSec: 900
        },
        transcription: {
          status: 'pending',
          attempts: 0
        }
      }
    ]
  });
}

test('audio transcription worker downloads, transcribes, stores transcript, and disconnects', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-audio-worker-'));
  const downloadedPath = path.join(tmp, 'downloaded.ogg');
  const store = storeWithPendingAudio();
  let disconnected = false;

  const worker = createAudioTranscriptionWorker({
    config: baseConfig({ audioTranscriptionWorkDir: tmp }),
    store,
    createClient: async () => ({
      disconnect: async () => {
        disconnected = true;
      }
    }),
    createTranscriber: () => ({
      transcribe: async (filePath, args) => {
        assert.equal(filePath, downloadedPath);
        assert.equal(args.durationSec, 900);
        return {
          model: 'gpt-4o-transcribe',
          responseFormat: 'json',
          text: 'Decision: build the transcription pipeline.',
          usage: { type: 'tokens', total_tokens: 42 },
          language: 'en',
          duration: 900,
          segments: []
        };
      }
    }),
    getMessage: async ({ sourceId, messageId }) => ({ sourceId, messageId }),
    downloadAudio: async () => {
      await fs.writeFile(downloadedPath, 'audio-bytes');
      return { filePath: downloadedPath, size: 11 };
    },
    now: () => new Date('2026-07-09T10:00:00.000Z')
  });

  const result = await worker.runOnce({ force: true });

  assert.equal(result.completed, 1);
  assert.equal(disconnected, true);
  const messages = await store.findMessages({ sourceIds: ['saved'], query: 'pipeline' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].transcription.status, 'done');
  await assert.rejects(() => fs.stat(downloadedPath), /ENOENT/);
});

test('audio transcription worker schedules retry before final failure', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-audio-worker-fail-'));
  const store = storeWithPendingAudio();
  let currentNow = new Date('2026-07-09T10:00:00.000Z');

  const worker = createAudioTranscriptionWorker({
    config: baseConfig({ audioTranscriptionWorkDir: tmp, audioTranscriptionMaxAttempts: 2 }),
    store,
    createClient: async () => ({
      disconnect: async () => {}
    }),
    createTranscriber: () => ({
      transcribe: async () => {
        throw new Error('OpenAI unavailable');
      }
    }),
    getMessage: async () => ({}),
    downloadAudio: async () => {
      const filePath = path.join(tmp, `downloaded-${Date.now()}.ogg`);
      await fs.writeFile(filePath, 'audio-bytes');
      return { filePath, size: 11 };
    },
    now: () => currentNow
  });

  const first = await worker.runOnce({ force: true });
  assert.equal(first.retryScheduled, 1);
  let [message] = await store.findMessages({ sourceIds: ['saved'] });
  assert.equal(message.transcription.status, 'pending');
  assert.equal(message.transcription.attempts, 1);
  assert.ok(message.transcription.nextAttemptAt);

  const immediate = await worker.runOnce({ force: true });
  assert.equal(immediate.processedCount, 0);

  currentNow = new Date(message.transcription.nextAttemptAt);
  const second = await worker.runOnce({ force: true });
  assert.equal(second.failed, 1);
  [message] = await store.findMessages({ sourceIds: ['saved'] });
  assert.equal(message.transcription.status, 'failed');
  assert.equal(message.transcription.attempts, 2);
});

test('audio transcription worker skips background work without explicit transcription sources', async () => {
  const store = storeWithPendingAudio();
  let transcriberCreated = false;
  const worker = createAudioTranscriptionWorker({
    config: baseConfig({
      audioTranscriptionSourceIds: [],
      audioTranscriptionSourceTags: []
    }),
    store,
    createTranscriber: () => {
      transcriberCreated = true;
      return {
        transcribe: async () => ({ text: 'should not run' })
      };
    }
  });

  const result = await worker.runOnce({ force: true });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_transcription_sources');
  assert.equal(result.processedCount, 0);
  assert.equal(transcriberCreated, false);
});

test('audio transcription worker only claims configured transcription sources', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-audio-worker-sources-'));
  const downloadedPath = path.join(tmp, 'saved.ogg');
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'saved', title: 'Saved Messages', enabled: true, tags: [] },
      { sourceId: 'other', title: 'Other Chat', enabled: true, tags: [] }
    ],
    messages: [
      {
        sourceId: 'other',
        sourceTitle: 'Other Chat',
        messageId: 201,
        date: '2026-07-09T11:00:00.000Z',
        text: '',
        transcriptText: '',
        media: { kind: 'voice', mimeType: 'audio/ogg', durationSec: 60 },
        transcription: { status: 'pending', attempts: 0 }
      },
      {
        sourceId: 'saved',
        sourceTitle: 'Saved Messages',
        messageId: 101,
        date: '2026-07-09T10:00:00.000Z',
        text: '',
        transcriptText: '',
        media: { kind: 'voice', mimeType: 'audio/ogg', durationSec: 60 },
        transcription: { status: 'pending', attempts: 0 }
      }
    ]
  });

  const worker = createAudioTranscriptionWorker({
    config: baseConfig({
      audioTranscriptionSourceIds: ['saved'],
      audioTranscriptionWorkDir: tmp
    }),
    store,
    createClient: async () => ({
      disconnect: async () => {}
    }),
    createTranscriber: () => ({
      transcribe: async () => ({
        model: 'gpt-4o-transcribe',
        responseFormat: 'json',
        text: 'Saved transcript'
      })
    }),
    getMessage: async ({ sourceId, messageId }) => ({ sourceId, messageId }),
    downloadAudio: async () => {
      await fs.writeFile(downloadedPath, 'audio-bytes');
      return { filePath: downloadedPath, size: 11 };
    }
  });

  const result = await worker.runOnce({ force: true });

  assert.equal(result.completed, 1);
  assert.deepEqual(result.sourceIds, ['saved']);
  const savedMessages = await store.findMessages({ sourceIds: ['saved'], query: 'Saved transcript' });
  const otherMessages = await store.findMessages({ sourceIds: ['other'] });
  assert.equal(savedMessages.length, 1);
  assert.equal(otherMessages[0].transcription.status, 'pending');
});
