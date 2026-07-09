import { dayRange, normalizePeriod } from './dateRange.js';

const DEFAULT_TIMEZONE = 'Europe/Chisinau';
const URL_PATTERN = /https?:\/\/[^\s)]+/gi;
const IMPORTANT_PATTERN = /(important|urgent|block|blocked|decision|decided|todo|fix|bug|release|deploy|deadline|важн|срочн|решил|решили|договорил|надо|нужно|сделать|проверь|проверить|блок|баг|релиз)/i;
const ACTION_PATTERN = /(todo|action|follow up|fix|check|please|pls|надо|нужно|сделать|проверь|проверить|посмотри|ответь|пофикс|почини)/i;
const DECISION_PATTERN = /(decision|decided|agreed|resolved|итог|решили|решил|договорились|согласовали|финально)/i;

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

function summarize(messages, sourceById) {
  const ascMessages = [...messages].sort((a, b) => new Date(a.date) - new Date(b.date));
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
    links
  };
}

export class TelegramDigestService {
  constructor(store) {
    this.store = store;
  }

  async listSources({ includeDisabled = false, sourceIds = [], tags = [] } = {}) {
    const sources = await this.store.listSources({ includeDisabled, sourceIds, tags });
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

  async getDailyDigest({ date, timezone = DEFAULT_TIMEZONE, sourceIds = [], tags = [] } = {}) {
    const range = dayRange(date, timezone);
    return this.getPeriodSummary({
      fromDate: range.from,
      toDate: range.to,
      label: range.date,
      timezone,
      sourceIds,
      tags
    });
  }

  async getPeriodSummary({ from, to, fromDate, toDate, timezone = DEFAULT_TIMEZONE, sourceIds = [], tags = [] } = {}) {
    const range = fromDate && toDate
      ? { from: fromDate, to: toDate }
      : normalizePeriod({ from, to, timezone });
    const sources = await this.store.listSources({ sourceIds, tags });
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const messages = await this.store.findMessages({
      from: range.from,
      to: range.to,
      sourceIds,
      tags,
      sort: 'asc',
      limit: 500
    });

    const digest = {
      periodStart: toIso(range.from),
      periodEnd: toIso(range.to),
      timezone,
      sourceIds: sources.map((source) => source.sourceId),
      ...summarize(messages, sourceById),
      generatedAt: new Date().toISOString()
    };

    await this.store.saveDigest?.(digest);
    return digest;
  }

  async searchMessages({ query, from, to, timezone = DEFAULT_TIMEZONE, sourceIds = [], tags = [], limit = 20 } = {}) {
    if (!query || !query.trim()) {
      throw new Error('query is required');
    }

    const range = from && to ? normalizePeriod({ from, to, timezone }) : {};
    const sources = await this.store.listSources({ sourceIds, tags });
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const messages = await this.store.findMessages({
      from: range.from,
      to: range.to,
      sourceIds,
      tags,
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

  async getActionItems({ from, to, timezone = DEFAULT_TIMEZONE, sourceIds = [], tags = [], limit = 50 } = {}) {
    const range = from && to ? normalizePeriod({ from, to, timezone }) : dayRange(null, timezone);
    const sources = await this.store.listSources({ sourceIds, tags });
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const messages = await this.store.findMessages({
      from: range.from,
      to: range.to,
      sourceIds,
      tags,
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
