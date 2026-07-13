import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import OpenAI from 'openai';

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_CHUNK_SECONDS = 10 * 60;
const CHUNK_PREFIX = 'chunk-';

function parseChunkingStrategy(value) {
  if (!value) {
    return undefined;
  }

  const text = String(value).trim();
  if (!text) {
    return undefined;
  }
  if (text === 'auto') {
    return 'auto';
  }

  return JSON.parse(text);
}

function normalizeTranscriptionResponse(response, { chunk = null } = {}) {
  const text = typeof response === 'string' ? response : response?.text || '';
  return {
    text,
    language: response?.language || null,
    duration: response?.duration ?? null,
    segments: response?.segments || [],
    usage: response?.usage || null,
    chunk
  };
}

function promptWithContext(prompt, text) {
  const context = text.trim().slice(-1200);
  return [prompt, context ? `Previous transcript context:\n${context}` : '']
    .filter(Boolean)
    .join('\n\n');
}

function splitSegmentSeconds({ fileSize, durationSec, maxFileBytes }) {
  if (!durationSec || durationSec <= 0 || !fileSize || fileSize <= 0) {
    return DEFAULT_CHUNK_SECONDS;
  }

  const estimated = Math.floor((durationSec * maxFileBytes * 0.8) / fileSize);
  return Math.max(30, Math.min(DEFAULT_CHUNK_SECONDS, estimated));
}

async function runProcess(command, args, { spawnCommand = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function splitAudioFile({
  filePath,
  workDir,
  fileSize,
  durationSec,
  maxFileBytes,
  ffmpegPath,
  spawnCommand
}) {
  const chunkDir = await fsp.mkdtemp(path.join(workDir, 'chunks-'));
  const segmentSeconds = splitSegmentSeconds({ fileSize, durationSec, maxFileBytes });
  const pattern = path.join(chunkDir, `${CHUNK_PREFIX}%03d.mp3`);

  await runProcess(ffmpegPath, [
    '-y',
    '-i',
    filePath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '32k',
    '-f',
    'segment',
    '-segment_time',
    String(segmentSeconds),
    pattern
  ], { spawnCommand });

  const files = (await fsp.readdir(chunkDir))
    .filter((fileName) => fileName.startsWith(CHUNK_PREFIX) && fileName.endsWith('.mp3'))
    .sort()
    .map((fileName) => path.join(chunkDir, fileName));

  if (!files.length) {
    throw new Error('ffmpeg did not create audio chunks');
  }

  for (const file of files) {
    const stat = await fsp.stat(file);
    if (stat.size > maxFileBytes) {
      throw new Error(`Audio chunk is still larger than the OpenAI upload limit: ${stat.size} bytes`);
    }
  }

  return { chunkDir, files };
}

export function createOpenAiAudioTranscriber(config, options = {}) {
  const client = options.client || new OpenAI({
    apiKey: config.openAiApiKey
  });
  const model = config.openAiTranscriptionModel || 'gpt-4o-transcribe';
  const responseFormat = config.openAiTranscriptionResponseFormat || 'json';
  const maxFileBytes = config.audioTranscriptionMaxFileBytes || DEFAULT_MAX_FILE_BYTES;
  const workDir = config.audioTranscriptionWorkDir || './tmp/audio-transcriptions';
  const chunkingStrategy = parseChunkingStrategy(config.openAiTranscriptionChunkingStrategy);

  async function transcribeSingle(filePath, { prompt } = {}) {
    const request = {
      file: fs.createReadStream(filePath),
      model,
      response_format: responseFormat
    };
    if (prompt) {
      request.prompt = prompt;
    }
    if (config.openAiTranscriptionLanguage) {
      request.language = config.openAiTranscriptionLanguage;
    }
    if (chunkingStrategy) {
      request.chunking_strategy = chunkingStrategy;
    }

    const response = await client.audio.transcriptions.create(request);
    return normalizeTranscriptionResponse(response);
  }

  async function transcribe(filePath, { durationSec = null, prompt = config.openAiTranscriptionPrompt || '' } = {}) {
    const stat = await fsp.stat(filePath);
    if (stat.size <= maxFileBytes) {
      return {
        model,
        responseFormat,
        ...(await transcribeSingle(filePath, { prompt }))
      };
    }

    if (!config.audioTranscriptionSplitLargeFiles) {
      throw new Error(`Audio file is larger than the OpenAI upload limit: ${stat.size} bytes`);
    }

    await fsp.mkdir(workDir, { recursive: true });
    const { chunkDir, files } = await splitAudioFile({
      filePath,
      workDir,
      fileSize: stat.size,
      durationSec,
      maxFileBytes,
      ffmpegPath: config.ffmpegPath || 'ffmpeg',
      spawnCommand: options.spawnCommand
    });

    try {
      const chunks = [];
      let combinedText = '';
      for (let index = 0; index < files.length; index += 1) {
        const chunkResult = await transcribeSingle(files[index], {
          prompt: promptWithContext(prompt, combinedText)
        });
        const chunk = {
          index,
          fileName: path.basename(files[index]),
          text: chunkResult.text,
          usage: chunkResult.usage,
          duration: chunkResult.duration,
          language: chunkResult.language
        };
        chunks.push(chunk);
        combinedText = [combinedText, chunkResult.text].filter(Boolean).join('\n\n');
      }

      return {
        model,
        responseFormat,
        text: combinedText,
        language: chunks.find((chunk) => chunk.language)?.language || null,
        duration: null,
        segments: [],
        usage: null,
        chunks
      };
    } finally {
      await fsp.rm(chunkDir, { recursive: true, force: true });
    }
  }

  return {
    transcribe
  };
}
