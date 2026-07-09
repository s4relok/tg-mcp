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

function toInteger(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected integer, got ${value}`);
  }
  return parsed;
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
    timelineLimit: toInteger(query.timelineLimit, undefined),
    refresh: toBoolean(query.refresh),
    ...sourceFilters(query)
  };
}

export function parsePeriodSummaryQuery(query) {
  return {
    from: query.from ? String(query.from) : undefined,
    to: query.to ? String(query.to) : undefined,
    timezone: query.timezone ? String(query.timezone) : undefined,
    includeTimeline: toBoolean(query.includeTimeline, true),
    timelineLimit: toInteger(query.timelineLimit, undefined),
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
    timelineLimit: toInteger(query.timelineLimit, undefined),
    refresh: toBoolean(query.refresh)
  };
}

export function parseSearchQuery(query) {
  return {
    query: query.query ? String(query.query) : '',
    from: query.from ? String(query.from) : undefined,
    to: query.to ? String(query.to) : undefined,
    timezone: query.timezone ? String(query.timezone) : undefined,
    limit: toInteger(query.limit, undefined),
    ...sourceFilters(query)
  };
}

export function parseMessageContextQuery(query) {
  return {
    sourceId: query.sourceId ? String(query.sourceId) : '',
    messageId: toInteger(query.messageId, undefined),
    before: toInteger(query.before, undefined),
    after: toInteger(query.after, undefined)
  };
}

export function parseActionItemsQuery(query) {
  return {
    from: query.from ? String(query.from) : undefined,
    to: query.to ? String(query.to) : undefined,
    timezone: query.timezone ? String(query.timezone) : undefined,
    limit: toInteger(query.limit, undefined),
    ...sourceFilters(query)
  };
}
