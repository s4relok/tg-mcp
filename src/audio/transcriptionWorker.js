import fsp from 'node:fs/promises';

import { createOpenAiAudioTranscriber } from './openAiTranscriber.js';
import { downloadTelegramAudioMessage, getTelegramMessageById } from './telegramAudio.js';
import { createAuthorizedTelegramClient } from '../telegram/telegramSync.js';

function retryDelayMs(attempts) {
  return Math.min(15 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempts - 1));
}

async function removeDownloadedFile(filePath, logger) {
  if (!filePath) {
    return;
  }

  try {
    await fsp.rm(filePath, { force: true });
  } catch (error) {
    logger.warn(`Could not remove temporary audio file ${filePath}: ${error.message}`);
  }
}

export async function processAudioTranscriptionJob({
  job,
  client,
  config,
  store,
  transcriber,
  logger = console,
  getMessage = getTelegramMessageById,
  downloadAudio = downloadTelegramAudioMessage,
  now = () => new Date()
}) {
  let downloaded = null;
  try {
    const message = await getMessage({
      client,
      sourceId: job.sourceId,
      messageId: job.messageId
    });
    downloaded = await downloadAudio({
      client,
      message,
      job,
      workDir: config.audioTranscriptionWorkDir
    });
    const result = await transcriber.transcribe(downloaded.filePath, {
      durationSec: job.media?.durationSec || null
    });
    if (!result.text || !result.text.trim()) {
      throw new Error('OpenAI returned an empty transcript');
    }

    await store.completeAudioTranscription({
      sourceId: job.sourceId,
      messageId: job.messageId,
      transcriptText: result.text.trim(),
      model: result.model,
      responseFormat: result.responseFormat,
      usage: result.usage,
      language: result.language,
      duration: result.duration,
      segments: result.segments,
      chunks: result.chunks,
      now: now()
    });

    return {
      status: 'done',
      sourceId: job.sourceId,
      messageId: job.messageId,
      transcriptLength: result.text.trim().length
    };
  } catch (error) {
    const attempts = job.transcription?.attempts || 1;
    const finalFailure = attempts >= config.audioTranscriptionMaxAttempts;
    const nextAttemptAt = finalFailure ? null : new Date(now().getTime() + retryDelayMs(attempts));
    await store.failAudioTranscription({
      sourceId: job.sourceId,
      messageId: job.messageId,
      error,
      status: finalFailure ? 'failed' : 'pending',
      nextAttemptAt,
      now: now()
    });
    logger.warn(`Audio transcription failed for ${job.sourceId}/${job.messageId}: ${error.message}`);
    return {
      status: finalFailure ? 'failed' : 'retry_scheduled',
      sourceId: job.sourceId,
      messageId: job.messageId,
      error: error.message,
      nextAttemptAt: nextAttemptAt ? nextAttemptAt.toISOString() : null
    };
  } finally {
    await removeDownloadedFile(downloaded?.filePath, logger);
  }
}

export function createAudioTranscriptionWorker({
  config,
  store,
  logger = console,
  createClient = createAuthorizedTelegramClient,
  createTranscriber = createOpenAiAudioTranscriber,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  getMessage = getTelegramMessageById,
  downloadAudio = downloadTelegramAudioMessage,
  now = () => new Date()
}) {
  let stopped = false;
  let timer = null;
  let running = false;
  let transcriber = null;

  function getTranscriber() {
    if (!config.openAiApiKey) {
      throw new Error('OPENAI_API_KEY is required for audio transcription');
    }
    if (!transcriber) {
      transcriber = createTranscriber(config);
    }
    return transcriber;
  }

  async function runOnce({ limit, sourceIds = [], force = false } = {}) {
    if (!force && !config.openAiTranscriptionEnabled) {
      return { skipped: true, reason: 'disabled' };
    }
    if (running) {
      logger.warn('Audio transcription already running; skipping overlapping tick.');
      return { skipped: true, reason: 'already_running' };
    }
    if (!config.openAiApiKey) {
      return { error: 'OPENAI_API_KEY is required for audio transcription', processedCount: 0, results: [] };
    }

    running = true;
    let client = null;
    const results = [];
    const batchSize = Math.max(1, limit || config.audioTranscriptionBatchSize || 1);
    try {
      const activeTranscriber = getTranscriber();
      for (let index = 0; index < batchSize; index += 1) {
        const job = await store.claimNextAudioTranscription({
          sourceIds,
          lockMs: config.audioTranscriptionLockMs,
          now: now()
        });
        if (!job) {
          break;
        }

        if (!client) {
          client = await createClient(config);
        }
        results.push(await processAudioTranscriptionJob({
          job,
          client,
          config,
          store,
          transcriber: activeTranscriber,
          logger,
          getMessage,
          downloadAudio,
          now
        }));
      }

      const completed = results.filter((result) => result.status === 'done').length;
      const failed = results.filter((result) => result.status === 'failed').length;
      const retryScheduled = results.filter((result) => result.status === 'retry_scheduled').length;
      if (results.length) {
        logger.info(`Audio transcription complete: ${completed} done, ${failed} failed, ${retryScheduled} retry scheduled.`);
      }
      return {
        processedCount: results.length,
        completed,
        failed,
        retryScheduled,
        results
      };
    } catch (error) {
      logger.warn(`Audio transcription skipped: ${error.message}`);
      return { error: error.message, processedCount: results.length, results };
    } finally {
      running = false;
      if (client?.disconnect) {
        await client.disconnect();
      }
    }
  }

  function scheduleNext(delaySeconds = config.audioTranscriptionIntervalSeconds) {
    if (stopped) {
      return;
    }

    timer = setTimer(async () => {
      await runOnce();
      scheduleNext();
    }, Math.max(1, delaySeconds) * 1000);
  }

  function start() {
    if (!config.openAiTranscriptionEnabled) {
      logger.info('OpenAI audio transcription worker is disabled.');
      return { started: false };
    }
    if (!config.openAiApiKey) {
      logger.warn('OpenAI audio transcription worker is enabled but OPENAI_API_KEY is missing.');
      return {
        started: false,
        error: 'OPENAI_API_KEY is required for audio transcription'
      };
    }

    logger.info(`OpenAI audio transcription worker enabled every ${config.audioTranscriptionIntervalSeconds}s.`);
    if (config.audioTranscriptionOnStart) {
      queueMicrotask(async () => {
        await runOnce();
        scheduleNext();
      });
    } else {
      scheduleNext();
    }

    return { started: true };
  }

  async function stop() {
    stopped = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    runOnce
  };
}

export function startAudioTranscriptionWorker(options) {
  const worker = createAudioTranscriptionWorker(options);
  worker.start();
  return worker;
}
