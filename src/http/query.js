import { BadRequestError } from './errors.js';

function toArray(value) {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(toArray);
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function toInteger(value, fallback, { name = 'value', min, max } = {}) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    throw new BadRequestError(`${name} must be an integer`);
  }
  const parsed = Number.parseInt(text, 10);
  if (min !== undefined && parsed < min) {
    throw new BadRequestError(`${name} must be at least ${min}`);
  }
  if (max !== undefined && parsed > max) {
    throw new BadRequestError(`${name} must be at most ${max}`);
  }
  return parsed;
}

function requiredString(value, name) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) {
    throw new BadRequestError(`${name} is required`);
  }
  return text;
}

export function sourceFilters(query) {
  return {
    sourceIds: toArray(query.sourceId ?? query.sourceIds),
    tags: toArray(query.tag ?? query.tags),
    sourceQuery: query.sourceQuery ? String(query.sourceQuery) : query.source ? String(query.source) : ''
  };
}

export function parseSourcesQuery(query) {
  return {
    includeDisabled: toBoolean(query.includeDisabled),
    ...sourceFilters(query)
  };
}

export function parseDailyDigestQuery(query) {
  return {
    date: query.date ? String(query.date) : undefined,
    timezone: query.timezone ? String(query.timezone) : undefined,
    includeTimeline: toBoolean(query.includeTimeline, true),
    timelineLimit: toInteger(query.timelineLimit, undefined, { name: 'timelineLimit', min: 1, max: 200 }),
    refresh: toBoolean(query.refresh),
    ...sourceFilters(query)
  };
}

export function parsePeriodSummaryQuery(query) {
  return {
    from: requiredString(query.from, 'from'),
    to: requiredString(query.to, 'to'),
    timezone: query.timezone ? String(query.timezone) : undefined,
    includeTimeline: toBoolean(query.includeTimeline, true),
    timelineLimit: toInteger(query.timelineLimit, undefined, { name: 'timelineLimit', min: 1, max: 200 }),
    refresh: toBoolean(query.refresh),
    ...sourceFilters(query)
  };
}

export function parseSourceSummaryQuery(query, params = {}) {
  return {
    sourceId: params.sourceId ? String(params.sourceId) : query.sourceId ? String(query.sourceId) : '',
    date: query.date ? String(query.date) : undefined,
    from: query.from ? String(query.from) : undefined,
    to: query.to ? String(query.to) : undefined,
    timezone: query.timezone ? String(query.timezone) : undefined,
    includeTimeline: toBoolean(query.includeTimeline, true),
    timelineLimit: toInteger(query.timelineLimit, undefined, { name: 'timelineLimit', min: 1, max: 200 }),
    refresh: toBoolean(query.refresh)
  };
}

export function parseSearchQuery(query) {
  return {
    query: requiredString(query.query, 'query'),
    from: query.from ? String(query.from) : undefined,
    to: query.to ? String(query.to) : undefined,
    timezone: query.timezone ? String(query.timezone) : undefined,
    limit: toInteger(query.limit, undefined, { name: 'limit', min: 1, max: 100 }),
    ...sourceFilters(query)
  };
}

export function parseMessageContextQuery(query) {
  return {
    sourceId: requiredString(query.sourceId, 'sourceId'),
    messageId: toInteger(requiredString(query.messageId, 'messageId'), undefined, { name: 'messageId' }),
    before: toInteger(query.before, undefined, { name: 'before', min: 0, max: 50 }),
    after: toInteger(query.after, undefined, { name: 'after', min: 0, max: 50 })
  };
}

export function parseActionItemsQuery(query) {
  return {
    from: query.from ? String(query.from) : undefined,
    to: query.to ? String(query.to) : undefined,
    timezone: query.timezone ? String(query.timezone) : undefined,
    limit: toInteger(query.limit, undefined, { name: 'limit', min: 1, max: 100 }),
    ...sourceFilters(query)
  };
}

export function parseSyncStatusQuery(query) {
  return {
    includeDisabled: toBoolean(query.includeDisabled),
    staleAfterHours: toInteger(query.staleAfterHours, undefined, { name: 'staleAfterHours', min: 1, max: 168 }),
    ...sourceFilters(query)
  };
}
