function normalizedSourceId(sourceId) {
  return String(sourceId ?? '').trim();
}

export async function resolveEligibleSource({ store, config, sourceId }) {
  const id = normalizedSourceId(sourceId);
  if (!id) {
    return {
      eligible: false,
      sourceId: id,
      reason: 'invalid_source_id',
      message: 'sourceId must be a non-empty exact Telegram source id.'
    };
  }

  const sources = await store.listSources({
    includeDisabled: true,
    sourceIds: [id]
  });
  const source = sources.find((item) => String(item.sourceId) === id);
  if (!source) {
    return {
      eligible: false,
      sourceId: id,
      reason: 'not_found',
      message: `Telegram source ${id} was not found.`
    };
  }
  if (source.enabled === false) {
    return {
      eligible: false,
      sourceId: id,
      source,
      reason: 'disabled',
      message: `Telegram source ${id} is disabled.`
    };
  }

  const ceiling = new Set((config.allowedSourceIds || []).map(String));
  if (ceiling.size && !ceiling.has(id)) {
    return {
      eligible: false,
      sourceId: id,
      source,
      reason: 'outside_allowed_source_ids',
      message: `Telegram source ${id} is outside ALLOWED_SOURCE_IDS.`
    };
  }

  return {
    eligible: true,
    sourceId: id,
    source
  };
}
