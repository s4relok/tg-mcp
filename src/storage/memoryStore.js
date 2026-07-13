export class MemoryTelegramStore {
  constructor({ sources = [], messages = [] } = {}) {
    this.sources = sources.map((source) => ({ enabled: true, tags: [], ...source }));
    this.messages = messages.map((message) => ({ ...message, date: new Date(message.date) }));
    this.savedDigests = [];
  }

  async ensureIndexes() {}

  async health() {
    return { ok: true, driver: 'memory', database: 'memory' };
  }

  async close() {}

  async upsertSource(source, { preserveEnabled = false, preserveTags = true } = {}) {
    const index = this.sources.findIndex((item) => item.sourceId === source.sourceId);
    if (index >= 0) {
      const next = { ...this.sources[index], ...source };
      if (preserveEnabled) {
        next.enabled = this.sources[index].enabled;
      }
      if (preserveTags) {
        next.tags = this.sources[index].tags;
      }
      this.sources[index] = next;
      return;
    }
    this.sources.push({ enabled: true, tags: [], ...source });
  }

  async setSourceEnabled(sourceId, enabled) {
    const source = this.sources.find((item) => item.sourceId === sourceId);
    if (!source) {
      return null;
    }
    source.enabled = enabled;
    return source;
  }

  async setSourceTags(sourceId, tags) {
    const source = this.sources.find((item) => item.sourceId === sourceId);
    if (!source) {
      return null;
    }
    source.tags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    return source;
  }

  async markSourceSynced(sourceId, { lastSyncedMessageId = null, messageCount = 0 } = {}) {
    const source = this.sources.find((item) => item.sourceId === sourceId);
    if (!source) {
      return null;
    }

    if (lastSyncedMessageId !== null && lastSyncedMessageId !== undefined) {
      source.lastSyncedMessageId = Math.max(source.lastSyncedMessageId || 0, lastSyncedMessageId);
    }
    source.lastSyncedAt = new Date();
    source.lastSyncMessageCount = messageCount;
    return source;
  }

  async upsertMessages(messages) {
    for (const message of messages) {
      const index = this.messages.findIndex(
        (item) => item.sourceId === message.sourceId && item.messageId === message.messageId
      );
      const normalized = { ...message, date: new Date(message.date) };
      if (index >= 0) {
        const existing = this.messages[index];
        this.messages[index] = {
          ...existing,
          ...normalized,
          transcriptText: existing.transcriptText || normalized.transcriptText || '',
          transcription: existing.transcription || normalized.transcription
        };
      } else {
        this.messages.push(normalized);
      }
    }

    return { insertedOrUpdated: messages.length };
  }

  async claimNextAudioTranscription({ sourceIds = [], lockMs = 10 * 60 * 1000, now = new Date() } = {}) {
    const candidate = this.messages
      .filter((message) => ['audio', 'voice'].includes(message.media?.kind))
      .filter((message) => !sourceIds.length || sourceIds.includes(message.sourceId))
      .filter((message) => !message.transcriptText)
      .filter((message) => (
        (
          message.transcription?.status === 'pending' &&
          (
            !message.transcription?.nextAttemptAt ||
            new Date(message.transcription.nextAttemptAt) <= now
          )
        ) ||
        (
          message.transcription?.status === 'processing' &&
          message.transcription?.lockUntil &&
          new Date(message.transcription.lockUntil) <= now
        )
      ))
      .sort((a, b) => b.date - a.date)[0];

    if (!candidate) {
      return null;
    }

    candidate.transcription = {
      ...(candidate.transcription || {}),
      status: 'processing',
      attempts: (candidate.transcription?.attempts || 0) + 1,
      startedAt: now,
      lockUntil: new Date(now.getTime() + lockMs),
      updatedAt: now
    };
    return { ...candidate };
  }

  async completeAudioTranscription({
    sourceId,
    messageId,
    transcriptText,
    model,
    responseFormat,
    usage = null,
    language = null,
    duration = null,
    segments = [],
    chunks = [],
    now = new Date()
  }) {
    const message = this.messages.find((item) => item.sourceId === sourceId && item.messageId === messageId);
    if (!message) {
      return null;
    }

    message.transcriptText = transcriptText;
    message.transcription = {
      ...(message.transcription || {}),
      status: 'done',
      model: model || null,
      responseFormat: responseFormat || null,
      usage,
      language,
      duration,
      segments,
      chunks,
      completedAt: now,
      updatedAt: now
    };
    delete message.transcription.lockUntil;
    delete message.transcription.error;
    delete message.transcription.nextAttemptAt;
    const source = this.sources.find((item) => item.sourceId === sourceId);
    if (source) {
      source.updatedAt = now;
    }
    return { ...message };
  }

  async failAudioTranscription({ sourceId, messageId, error, status = 'failed', nextAttemptAt = null, now = new Date() }) {
    const message = this.messages.find((item) => item.sourceId === sourceId && item.messageId === messageId);
    if (!message) {
      return null;
    }

    message.transcription = {
      ...(message.transcription || {}),
      status,
      error: String(error?.message || error || 'Transcription failed'),
      failedAt: now,
      updatedAt: now
    };
    if (nextAttemptAt) {
      message.transcription.nextAttemptAt = nextAttemptAt;
    } else {
      delete message.transcription.nextAttemptAt;
    }
    delete message.transcription.lockUntil;
    return { ...message };
  }

  async resetFailedAudioTranscriptions({ sourceIds = [], limit = 100, now = new Date() } = {}) {
    const candidates = this.messages
      .filter((message) => ['audio', 'voice'].includes(message.media?.kind))
      .filter((message) => !sourceIds.length || sourceIds.includes(message.sourceId))
      .filter((message) => message.transcription?.status === 'failed')
      .sort((a, b) => b.date - a.date)
      .slice(0, Math.min(limit, 500));

    for (const message of candidates) {
      message.transcription = {
        ...(message.transcription || {}),
        status: 'pending',
        attempts: 0,
        updatedAt: now
      };
      delete message.transcription.error;
      delete message.transcription.failedAt;
      delete message.transcription.lockUntil;
      delete message.transcription.nextAttemptAt;
    }

    return { resetCount: candidates.length };
  }

  async getAudioTranscriptionStatus({ sourceIds = [] } = {}) {
    const counts = {
      pending: 0,
      processing: 0,
      done: 0,
      failed: 0,
      missing: 0
    };
    for (const message of this.messages) {
      if (!['audio', 'voice'].includes(message.media?.kind)) {
        continue;
      }
      if (sourceIds.length && !sourceIds.includes(message.sourceId)) {
        continue;
      }
      counts[message.transcription?.status || 'missing'] += 1;
    }

    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return { total, counts };
  }

  async listSources({ includeDisabled = false, sourceIds = [], tags = [], sourceQuery = '' } = {}) {
    const normalizedQuery = sourceQuery.trim().toLowerCase();
    return this.sources
      .filter((source) => includeDisabled || source.enabled)
      .filter((source) => !sourceIds.length || sourceIds.includes(source.sourceId))
      .filter((source) => !tags.length || tags.some((tag) => source.tags.includes(tag)))
      .filter((source) => {
        if (!normalizedQuery) {
          return true;
        }

        const haystack = [
          source.sourceId,
          source.title,
          source.username,
          ...(source.tags || [])
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async resolveSourceIds({ sourceIds = [], tags = [], sourceQuery = '', includeDisabled = false } = {}) {
    const sources = await this.listSources({ sourceIds, tags, sourceQuery, includeDisabled });
    return sources.map((source) => source.sourceId);
  }

  async findMessages({ from, to, sourceIds = [], tags = [], sourceQuery = '', query = '', limit = 100, sort = 'desc' } = {}) {
    const resolvedSourceIds = await this.resolveSourceIds({ sourceIds, tags, sourceQuery });
    if (!resolvedSourceIds.length) {
      return [];
    }

    const lowerQuery = query.trim().toLowerCase();
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;

    return this.messages
      .filter((message) => resolvedSourceIds.includes(message.sourceId))
      .filter((message) => !fromDate || message.date >= fromDate)
      .filter((message) => !toDate || message.date < toDate)
      .filter((message) => !lowerQuery || `${message.text || ''} ${message.transcriptText || ''} ${message.senderName || ''} ${message.link || ''}`.toLowerCase().includes(lowerQuery))
      .sort((a, b) => sort === 'asc' ? a.date - b.date : b.date - a.date)
      .slice(0, Math.min(limit, 500));
  }

  async getMessageContext({ sourceId, messageId, before = 5, after = 5 }) {
    const sourceMessages = this.messages
      .filter((message) => message.sourceId === sourceId)
      .sort((a, b) => a.messageId - b.messageId);
    const index = sourceMessages.findIndex((message) => message.messageId === messageId);
    if (index < 0) {
      return null;
    }

    return {
      target: sourceMessages[index],
      before: sourceMessages.slice(Math.max(0, index - before), index),
      after: sourceMessages.slice(index + 1, index + 1 + after)
    };
  }

  async findDigest(cacheKey) {
    if (!cacheKey) {
      return null;
    }

    const digest = this.savedDigests.find((item) => item.cacheKey === cacheKey);
    return digest ? { ...digest } : null;
  }

  async saveDigest(digest) {
    const index = this.savedDigests.findIndex((item) => item.cacheKey === digest.cacheKey);
    if (index >= 0) {
      this.savedDigests[index] = { ...digest };
    } else {
      this.savedDigests.push({ ...digest });
    }
  }
}
