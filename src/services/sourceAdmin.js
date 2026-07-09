function compactSource(source) {
  return {
    sourceId: source.sourceId,
    title: source.title,
    username: source.username || null,
    type: source.type || 'unknown',
    enabled: source.enabled !== false,
    tags: source.tags || []
  };
}

function sourceExactScore(source, query) {
  const normalizedQuery = query.trim().toLowerCase();
  const values = [
    source.sourceId,
    source.title,
    source.username
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());

  return values.includes(normalizedQuery);
}

export async function findSourcesForSelection(store, { query = '', includeDisabled = true, limit = 30 } = {}) {
  const sources = await store.listSources({
    includeDisabled,
    sourceQuery: query
  });

  return {
    query,
    count: sources.length,
    sources: sources.slice(0, limit).map(compactSource),
    truncated: sources.length > limit
  };
}

export async function selectSource(store, { query, tags = [] } = {}) {
  if (!query || !query.trim()) {
    throw new Error('select-source requires a source query');
  }

  const candidates = await store.listSources({
    includeDisabled: true,
    sourceQuery: query
  });

  if (!candidates.length) {
    return {
      status: 'not_found',
      query,
      message: 'No Telegram source matches that query.',
      candidates: []
    };
  }

  const exactCandidates = candidates.filter((source) => sourceExactScore(source, query));
  const selected = candidates.length === 1
    ? candidates[0]
    : exactCandidates.length === 1
      ? exactCandidates[0]
      : null;

  if (!selected) {
    return {
      status: 'ambiguous',
      query,
      message: 'Multiple Telegram sources match that query. Use a more specific source id, title, or username.',
      candidates: candidates.slice(0, 30).map(compactSource),
      truncated: candidates.length > 30
    };
  }

  await store.setSourceEnabled(selected.sourceId, true);
  if (tags.length) {
    await store.setSourceTags(selected.sourceId, tags);
  }

  const [updated] = await store.listSources({
    includeDisabled: true,
    sourceIds: [selected.sourceId]
  });

  return {
    status: 'selected',
    query,
    source: compactSource(updated || selected)
  };
}
