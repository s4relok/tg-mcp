import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTelegramAudioService } from '../src/audio/audioService.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function audioMessage(messageId, overrides = {}) {
  return {
    sourceId: 'work',
    sourceTitle: 'Work Chat',
    messageId,
    date: '2026-08-24T10:00:00.000Z',
    text: '',
    media: {
      kind: 'voice',
      mimeType: 'audio/ogg',
      size: 12,
      durationSec: 125,
      fileName: null
    },
    ...overrides
  };
}

function serviceConfig(overrides = {}) {
  return {
    allowedSourceIds: [],
    mcpAudioGetMaxItems: 3,
    mcpAudioMaxFileBytes: 1024,
    mcpAudioMaxTotalBytes: 2048,
    audioTranscriptionWorkDir: os.tmpdir(),
    ...overrides
  };
}

test('getTelegramAudio returns original bytes with correct MCP MIME metadata and removes the temporary file', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-audio-service-'));
  const original = Buffer.from('original-ogg-bytes');
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'work', title: 'Work Chat', enabled: true }],
    messages: [audioMessage(75606)]
  });
  let downloadedPath = null;
  let disconnected = false;
  const service = createTelegramAudioService({
    config: serviceConfig({ audioTranscriptionWorkDir: workDir }),
    store,
    createClient: async () => ({
      disconnect: async () => {
        disconnected = true;
      }
    }),
    getMessage: async () => ({
      voice: { mimeType: 'audio/ogg', size: original.length }
    }),
    downloadAudio: async ({ workDir: requestedWorkDir, maxFileBytes }) => {
      assert.equal(requestedWorkDir, workDir);
      assert.equal(maxFileBytes, 1024);
      downloadedPath = path.join(workDir, 'download.ogg');
      await fs.writeFile(downloadedPath, original);
      return { filePath: downloadedPath, size: original.length };
    }
  });

  const result = await service.getTelegramAudio({
    sourceId: 'work',
    messageIds: [75606]
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.totalBytes, original.length);
  assert.equal(result.items[0].mimeType, 'audio/ogg');
  assert.equal(result.items[0].fileName, 'telegram-audio-75606.ogg');
  assert.equal(result.items[0].audio.media.durationSec, 125);
  assert.deepEqual(Buffer.from(result.items[0].data, 'base64'), original);
  assert.equal(disconnected, true);
  await assert.rejects(fs.stat(downloadedPath), /ENOENT/);
});

test('getTelegramAudio rejects unknown, disabled, and outside-allowlist sources before Telegram access', async () => {
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'disabled', title: 'Disabled', enabled: false },
      { sourceId: 'outside', title: 'Outside', enabled: true }
    ]
  });
  let clientCalls = 0;
  const service = createTelegramAudioService({
    config: serviceConfig({ allowedSourceIds: ['allowed'] }),
    store,
    createClient: async () => {
      clientCalls += 1;
      return {};
    }
  });

  const missing = await service.getTelegramAudio({ sourceId: 'missing', messageIds: [1] });
  const disabled = await service.getTelegramAudio({ sourceId: 'disabled', messageIds: [1] });
  const outside = await service.getTelegramAudio({ sourceId: 'outside', messageIds: [1] });

  assert.equal(missing.reason, 'not_found');
  assert.equal(disabled.reason, 'disabled');
  assert.equal(outside.reason, 'outside_allowed_source_ids');
  assert.equal(clientCalls, 0);
});

test('getTelegramAudio reports an exact missing message and rejects non-audio media without Telegram access', async () => {
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'work', title: 'Work Chat', enabled: true }],
    messages: [{
      ...audioMessage(2),
      media: { kind: 'photo', mimeType: 'image/jpeg', size: 10 }
    }]
  });
  let clientCalls = 0;
  const service = createTelegramAudioService({
    config: serviceConfig(),
    store,
    createClient: async () => {
      clientCalls += 1;
      return {};
    }
  });

  const result = await service.getTelegramAudio({
    sourceId: 'work',
    messageIds: [999, 2]
  });

  assert.equal(result.status, 'error');
  assert.match(result.items[0].error, /not found/);
  assert.match(result.items[1].error, /not voice\/audio/);
  assert.equal(clientCalls, 0);
});

test('getTelegramAudio rejects unsupported MIME and oversized metadata before downloading', async () => {
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'work', title: 'Work Chat', enabled: true }],
    messages: [
      audioMessage(1, {
        media: { kind: 'audio', mimeType: 'application/octet-stream', size: 10 }
      }),
      audioMessage(2, {
        media: { kind: 'voice', mimeType: 'audio/ogg', size: 1025 }
      })
    ]
  });
  let clientCalls = 0;
  const service = createTelegramAudioService({
    config: serviceConfig(),
    store,
    createClient: async () => {
      clientCalls += 1;
      return {};
    }
  });

  const result = await service.getTelegramAudio({
    sourceId: 'work',
    messageIds: [1, 2]
  });

  assert.match(result.items[0].error, /Unsupported audio MIME/);
  assert.match(result.items[1].error, /1024 byte limit/);
  assert.equal(clientCalls, 0);
});

test('getTelegramAudio enforces the downloaded byte limit and always removes rejected files', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-audio-limit-'));
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'work', title: 'Work Chat', enabled: true }],
    messages: [audioMessage(1, { media: { kind: 'audio', mimeType: 'audio/mpeg' } })]
  });
  const oversized = Buffer.alloc(1025, 1);
  const filePath = path.join(workDir, 'oversized.mp3');
  const service = createTelegramAudioService({
    config: serviceConfig({ audioTranscriptionWorkDir: workDir }),
    store,
    createClient: async () => ({ disconnect: async () => {} }),
    getMessage: async () => ({ audio: { mimeType: 'audio/mpeg', size: 100 } }),
    downloadAudio: async () => {
      await fs.writeFile(filePath, oversized);
      return { filePath, size: oversized.length };
    }
  });

  const result = await service.getTelegramAudio({ sourceId: 'work', messageIds: [1] });

  assert.equal(result.status, 'error');
  assert.match(result.items[0].error, /1024 byte limit/);
  await assert.rejects(fs.stat(filePath), /ENOENT/);
});

test('getTelegramAudio enforces the total response limit while preserving successful items', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mcp-audio-total-'));
  const store = new MemoryTelegramStore({
    sources: [{ sourceId: 'work', title: 'Work Chat', enabled: true }],
    messages: [audioMessage(1), audioMessage(2)]
  });
  const service = createTelegramAudioService({
    config: serviceConfig({
      audioTranscriptionWorkDir: workDir,
      mcpAudioMaxTotalBytes: 10
    }),
    store,
    createClient: async () => ({ disconnect: async () => {} }),
    getMessage: async () => ({ voice: { mimeType: 'audio/ogg', size: 6 } }),
    downloadAudio: async ({ job }) => {
      const filePath = path.join(workDir, `${job.messageId}.ogg`);
      await fs.writeFile(filePath, Buffer.from('123456'));
      return { filePath, size: 6 };
    }
  });

  const result = await service.getTelegramAudio({
    sourceId: 'work',
    messageIds: [1, 2]
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.items[0].status, 'ok');
  assert.match(result.items[1].error, /response limit/);
  assert.equal(result.totalBytes, 6);
  await assert.rejects(fs.stat(path.join(workDir, '1.ogg')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(workDir, '2.ogg')), /ENOENT/);
});
