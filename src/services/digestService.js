import { createHash } from 'node:crypto';

import { dayRange, normalizePeriod } from './dateRange.js';

const DEFAULT_TIMEZONE = 'Europe/Chisinau';
const URL_PATTERN = /https?:\/\/[^\s)]+/gi;
const IMPORTANT_PATTERN = /(important|urgent|block|blocked|decision|decided|todo|fix|bug|release|deploy|deadline|важн|срочн|решил|решили|договорил|надо|нужно|сделать|проверь|проверить|блок|баг|релиз)/i;
const ACTION_PATTERN = /(todo|action|follow up|fix|check|please|pls|надо|нужно|сделать|проверь|проверить|посмотри|ответь|пофикс|почини)/i;
const DECISION_PATTERN = /(decision|decided|agreed|resolved|итог|решили|решил|договорились|согласовали|финально)/i;
const DEFAULT_TIMELINE_LIMIT = 80;
const MAX_TIMELINE_LIMIT = 200;

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashObject(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function sourceSyncSignature(sources) {
  return sources
    .map((source) => ({
      sourceId: source.sourceId,
      title: source.title || '',
      username: source.username || '',
      tags: [...(source.tags || [])].sort(),
      lastSyncedMessageId: source.lastSyncedMessageId || null,
      lastSyncedAt: source.lastSyncedAt ? toIso(source.lastSyncedAt) : null,
      updatedAt: source.updatedAt ? toIso(source.updatedAt) : null
    }))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

function createDigestCacheKey({
  range,
  timezone,
  sourceIds,
  tags,
  sourceQuery,
  includeTimeline,
  timelineLimit,
  sources
}) {
  return hashObject({
    periodStart: toIso(range.from),
    periodEnd: toIso(range.to),
    timezone,
    requestedSourceIds: [...sourceIds].sort(),
    requestedTags: [...tags].sort(),
    sourceQuery,
    includeTimeline,
    timelineLimit,
    sources: sourceSyncSignature(sources)
  });
}

function publicMessage(message, sourceById = new Map()) {
  const source = sourceById.get(message.sourceId);
  return {
    sourceId: message.sourceId,
    sourceTitle: source?.title || message.sourceTitle || message.sourceId,
    messageId: message.messageId,
    date: toIso(message.date),
    senderName: message.senderName || null,
    text: message.text || '',
    link: message.link || null
  };
}

function messagePreview(message, sourceById) {
  const output = publicMessage(message, sourceById);
  if (output.text.length > 500) {
    output.text = `${output.text.slice(0, 497)}...`;
  }
  return output;
}

function messageExcerpt(message, sourceById) {
  const output = publicMessage(message, sourceById);
  if (output.text.length > 240) {
    output.text = `${output.text.slice(0, 237)}...`;
  }
  return output;
}

function extractLinks(messages) {
  const links = [];
  for (const message of messages) {
    const matches = String(message.text || '').match(URL_PATTERN) || [];
    for (const url of matches) {
      links.push({
        url,
        sourceId: message.sourceId,
        messageId: message.messageId,
        date: toIso(message.date)
      });
    }
  }
  return links.slice(0, 30);
}

function uniqueByMessage(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.sourceId}:${item.messageId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function clampLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function buildTimeline(messages, sourceById, limit) {
  return messages.slice(0, limit).map((message) => messageExcerpt(message, sourceById));
}

function buildSourceDigests(messages, sourceById) {
  const bySource = new Map();
  for (const message of messages) {
    const bucket = bySource.get(message.sourceId) || [];
    bucket.push(message);
    bySource.set(message.sourceId, bucket);
  }

  return [...bySource.entries()].map(([sourceId, sourceMessages]) => {
    const source = sourceById.get(sourceId);
    const important = uniqueByMessage(
      sourceMessages.filter((message) => (
        IMPORTANT_PATTERN.test(message.text || '') ||
        ACTION_PATTERN.test(message.text || '') ||
        DECISION_PATTERN.test(message.text || '') ||
        (message.text || '').includes('?')
      ))
    ).slice(0, 8);

    return {
      sourceId,
      title: source?.title || sourceId,
      messageCount: sourceMessages.length,
      firstMessages: sourceMessages.slice(0, 3).map((message) => messageExcerpt(message, sourceById)),
      importantMessages: important.map((message) => messageExcerpt(message, sourceById)),
      lastMessages: sourceMessages.slice(-3).map((message) => messageExcerpt(message, sourceById))
    };
  });
}

function summarize(messages, sourceById, { includeTimeline = true, timelineLimit = DEFAULT_TIMELINE_LIMIT } = {}) {
  const ascMessages = [...messages].sort((a, b) => new Date(a.date) - new Date(b.date));
  const clampedTimelineLimit = clampLimit(timelineLimit, DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT);
  const highlights = uniqueByMessage(
    ascMessages.filter((message) => IMPORTANT_PATTERN.test(message.text || '') || (message.text || '').includes('?'))
  ).slice(0, 15);
  const questions = ascMessages.filter((message) => (message.text || '').includes('?')).slice(0, 15);
  const decisions = ascMessages.filter((message) => DECISION_PATTERN.test(message.text || '')).slice(0, 15);
  const actionItems = ascMessages.filter((message) => ACTION_PATTERN.test(message.text || '')).slice(0, 15);
  const links = extractLinks(ascMessages);

  const sourceCounts = new Map();
  for (const message of ascMessages) {
    sourceCounts.set(message.sourceId, (sourceCounts.get(message.sourceId) || 0) + 1);
  }

  const sourceSummary = [...sourceCounts.entries()]
    .map(([sourceId, count]) => ({
      sourceId,
      title: sourceById.get(sourceId)?.title || sourceId,
      messageCount: count
    }))
    .sort((a, b) => b.messageCount - a.messageCount);

  const summary = ascMessages.length
    ? `${ascMessages.length} Telegram messages across ${sourceSummary.length} selected source(s). Found ${highlights.length} highlight(s), ${questions.length} question(s), ${decisions.length} decision marker(s), and ${actionItems.length} action candidate(s).`
    : 'No Telegram messages found for the selected sources and period.';

  return {
    summary,
    messageCount: ascMessages.length,
    sources: sourceSummary,
    highlights: highlights.map((message) => messagePreview(message, sourceById)),
    questions: questions.map((message) => messagePreview(message, sourceById)),
    decisions: decisions.map((message) => messagePreview(message, sourceById)),
    actionItems: actionItems.map((message) => messagePreview(message, sourceById)),
    links,
    sourceDigests: buildSourceDigests(ascMessages, sourceById),
    timeline: includeTimeline ? buildTimeline(ascMessages, sourceById, clampedTimelineLimit) : [],
    timelineTruncated: includeTimeline && ascMessages.length > clampedTimelineLimit
  };
}

export class TelegramDigestService {
  constructor(store) {
    this.store = store;
  }

  async listSources({ includeDisabled = false, sourceIds = [], tags = [], sourceQuery = '' } = {}) {
    const sources = await this.store.listSources({ includeDisabled, sourceIds, tags, sourceQuery });
    return {
      sources: sources.map((source) => ({
        sourceId: source.sourceId,
        title: source.title,
        username: source.username || null,
        type: source.type || 'unknown',
        enabled: source.enabled !== false,
        tags: source.tags || [],
        lastSyncedMessageId: source.lastSyncedMessageId || null,
        lastSyncedAt: source.lastSyncedAt ? toIso(source.lastSyncedAt) : null,
        lastSyncMessageCount: source.lastSyncMessageCount ?? null,
        updatedAt: source.updatedAt ? toIso(source.updatedAt) : null
      }))
    };
  }

  async getDailyDigest({ date, timezone = DEFAULT_TIMEZONE, sourceIds = [], tags = [], sourceQuery = '', includeTimeline = true, timelineLimit = DEFAULT_TIMELINE_LIMIT, refresh = false } = {}) {
    const range = dayRange(date, timezone);
    return this.getPeriodSummary({
      fromDate: range.from,
      toDate: range.to,
      label: range.date,
      timezone,
      sourceIds,
      tags,
      sourceQuery,
      includeTimeline,
      timelineLimit,
      refresh
    });
  }

  async getPeriodSummary({ from, to, fromDate, toDate, timezone = DEFAULT_TIMEZONE, sourceIds = [], tags = [], sourceQuery = '', includeTimeline = true, timelineLimit = DEFAULT_TIMELINE_LIMIT, refresh = false } = {}) {
    const range = fromDate && toDate
      ? { from: fromDate, to: toDate }
      : normalizePeriod({ from, to, timezone });
    const sources = await this.store.listSources({ sourceIds, tags, sourceQuery });
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const normalizedTimelineLimit = clampLimit(timelineLimit, DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT);
    const cacheKey = createDigestCacheKey({
      range,
      timezone,
      sourceIds,
      tags,
      sourceQuery,
      includeTimeline,
      timelineLimit: normalizedTimelineLimit,
      sources
    });

    if (!refresh && this.store.findDigest) {
      const cachedDigest = await this.store.findDigest(cacheKey);
      if (cachedDigest) {
        return {
          ...cachedDigest,
          cached: true
        };
      }
    }

    const messages = await this.store.findMessages({
      from: range.from,
      to: range.to,
      sourceIds,
      tags,
      sourceQuery,
      sort: 'asc',
      limit: 500
    });

    const digest = {
      periodStart: toIso(range.from),
      periodEnd: toIso(range.to),
      timezone,
      sourceIds: sources.map((source) => source.sourceId),
      cacheKey,
      cached: false,
      ...summarize(messages, sourceById, { includeTimeline, timelineLimit: normalizedTimelineLimit }),
      generatedAt: new Date().toISOString()
    };

    await this.store.saveDigest?.(digest);
    return digest;
  }

  async getSourceSummary({ sourceId, date, from, to, timezone = DEFAULT_TIMEZONE, includeTimeline = true, timelineLimit = DEFAULT_TIMELINE_LIMIT, refresh = false } = {}) {
    if (!sourceId) {
      throw new Error('sourceId is required');
    }

    const { sources } = await this.listSources({ includeDisabled: true, sourceIds: [sourceId] });
    const source = sources[0] || null;
    if (!source) {
      return {
        found: false,
        sourceId,
        summary: 'Telegram source was not found. Run refresh-sources first.',
        messageCount: 0,
        source: null
      };
    }

    if (!source.enabled) {
      return {
        found: false,
        sourceId,
        summary: 'Telegram source is disabled. Enable it before requesting summaries.',
        messageCount: 0,
        source
      };
    }

    const digest = from || to
      ? await this.getPeriodSummary({
        from,
        to,
        timezone,
        sourceIds: [sourceId],
        includeTimeline,
        timelineLimit,
        refresh
      })
      : await this.getDailyDigest({
        date,
        timezone,
        sourceIds: [sourceId],
        includeTimeline,
        timelineLimit,
        refresh
      });

    return {
      found: true,
      source,
      ...digest
    };
  }

  async searchMessages({ query, from, to, timezone = DEFAULT_TIMEZONE, sourceIds = [], tags = [], sourceQuery = '', limit = 20 } = {}) {
    if (!query || !query.trim()) {
      throw new Error('query is required');
    }

    const range = from && to ? normalizePeriod({ from, to, timezone }) : {};
    const sources = await this.store.listSources({ sourceIds, tags, sourceQuery });
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const messages = await this.store.findMessages({
      from: range.from,
      to: range.to,
      sourceIds,
      tags,
      sourceQuery,
      query,
      limit
    });

    return {
      query,
      count: messages.length,
      results: messages.map((message) => messagePreview(message, sourceById))
    };
  }

  async getMessageContext({ sourceId, messageId, before = 5, after = 5 }) {
    const context = await this.store.getMessageContext({
      sourceId,
      messageId,
      before,
      after
    });

    if (!context) {
      return { found: false, sourceId, messageId };
    }

    const sources = await this.store.listSources({ sourceIds: [sourceId] });
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    return {
      found: true,
      target: publicMessage(context.target, sourceById),
      before: context.before.map((message) => publicMessage(message, sourceById)),
      after: context.after.map((message) => publicMessage(message, sourceById))
    };
  }

  async getActionItems({ from, to, timezone = DEFAULT_TIMEZONE, sourceIds = [], tags = [], sourceQuery = '', limit = 50 } = {}) {
    const range = from && to ? normalizePeriod({ from, to, timezone }) : dayRange(null, timezone);
    const sources = await this.store.listSources({ sourceIds, tags, sourceQuery });
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const messages = await this.store.findMessages({
      from: range.from,
      to: range.to,
      sourceIds,
      tags,
      sourceQuery,
      limit: 500,
      sort: 'asc'
    });

    const candidates = messages
      .filter((message) => ACTION_PATTERN.test(message.text || '') || (message.text || '').includes('?'))
      .slice(0, limit)
      .map((message) => ({
        ...messagePreview(message, sourceById),
        reason: ACTION_PATTERN.test(message.text || '') ? 'action-like wording' : 'open question'
      }));

    return {
      periodStart: toIso(range.from),
      periodEnd: toIso(range.to),
      timezone,
      count: candidates.length,
      actionItems: candidates
    };
  }
}

export function createTelegramDigestService(store) {
  return new TelegramDigestService(store);
}
