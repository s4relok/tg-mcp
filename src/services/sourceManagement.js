const SETTINGS_KEYS = new Set([
  'syncIntervalSeconds',
  'historyDepthDays',
  'includeMedia',
  'includeReplies',
  'includeForwardedPosts',
  'priority'
]);

export class SourceManagementError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SourceManagementError';
    this.code = code;
    this.details = details;
  }
}

export function normalizeSourceTags(tags = []) {
  if (!Array.isArray(tags)) {
    throw new SourceManagementError('invalid_tags', 'tags must be an array');
  }

  const normalized = tags
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean);

  for (const tag of normalized) {
    if (tag.length > 64) {
      throw new SourceManagementError('invalid_tags', 'tags must be at most 64 characters');
    }
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]*$/u.test(tag)) {
      throw new SourceManagementError(
        'invalid_tags',
        `Invalid tag: ${tag}. Use letters, numbers, underscore, dot, colon, or dash.`
      );
    }
  }

  return [...new Set(normalized)];
}

function optionalBoundedInteger(value, name, { min, max }) {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SourceManagementError(
      'invalid_settings',
      `${name} must be null or an integer between ${min} and ${max}`
    );
  }
  return value;
}

export function normalizeSourceSettingsPatch(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SourceManagementError('invalid_settings', 'settings must be an object');
  }

  const unknown = Object.keys(patch).filter((key) => !SETTINGS_KEYS.has(key));
  if (unknown.length) {
    throw new SourceManagementError(
      'invalid_settings',
      `Unknown source setting(s): ${unknown.join(', ')}`
    );
  }

  const normalized = {};
  if (Object.hasOwn(patch, 'syncIntervalSeconds')) {
    normalized.syncIntervalSeconds = optionalBoundedInteger(
      patch.syncIntervalSeconds,
      'syncIntervalSeconds',
      { min: 60, max: 7 * 24 * 60 * 60 }
    );
  }
  if (Object.hasOwn(patch, 'historyDepthDays')) {
    normalized.historyDepthDays = optionalBoundedInteger(
      patch.historyDepthDays,
      'historyDepthDays',
      { min: 1, max: 3650 }
    );
  }
  for (const key of ['includeMedia', 'includeReplies', 'includeForwardedPosts']) {
    if (Object.hasOwn(patch, key)) {
      if (typeof patch[key] !== 'boolean') {
        throw new SourceManagementError('invalid_settings', `${key} must be a boolean`);
      }
      normalized[key] = patch[key];
    }
  }
  if (Object.hasOwn(patch, 'priority')) {
    normalized.priority = optionalBoundedInteger(patch.priority, 'priority', { min: 0, max: 100 });
  }

  if (!Object.keys(normalized).length) {
    throw new SourceManagementError('invalid_settings', 'At least one source setting is required');
  }

  return normalized;
}

export function sourceSettingsDefaults(config = {}) {
  return {
    syncIntervalSeconds: config.sourceDefaultSyncIntervalSeconds ?? config.telegramSyncIntervalSeconds ?? 300,
    historyDepthDays: config.sourceDefaultHistoryDepthDays ?? 30,
    includeMedia: config.sourceDefaultIncludeMedia ?? true,
    includeReplies: config.sourceDefaultIncludeReplies ?? true,
    includeForwardedPosts: config.sourceDefaultIncludeForwardedPosts ?? true,
    priority: config.sourceDefaultPriority ?? 50
  };
}

export function effectiveSourceSettings(source, config = {}) {
  const defaults = sourceSettingsDefaults(config);
  const stored = source?.settings || {};
  const settings = {};
  const inherited = [];

  for (const key of SETTINGS_KEYS) {
    if (stored[key] === undefined || stored[key] === null) {
      settings[key] = defaults[key];
      inherited.push(key);
    } else {
      settings[key] = stored[key];
    }
  }

  return { settings, inherited };
}

export function isSensitiveSource(source) {
  const type = String(source?.type || '').toLowerCase();
  return type === 'user' || type === 'chat' || !source?.username;
}

function compactSource(source, config) {
  const effective = effectiveSourceSettings(source, config);
  return {
    sourceId: source.sourceId,
    title: source.title,
    username: source.username || null,
    type: source.type || 'unknown',
    sensitive: isSensitiveSource(source),
    enabled: source.enabled === true,
    tags: source.tags || [],
    settings: source.settings || {},
    effectiveSettings: effective.settings,
    inheritedSettings: effective.inherited,
    settingsVersion: source.settingsVersion || 0,
    nextSyncAt: source.nextSyncAt || null,
    lastSyncedAt: source.lastSyncedAt || null,
    lastSyncError: source.lastSyncError || null
  };
}

function applyTagMode(existing, tags, mode) {
  const current = normalizeSourceTags(existing || []);
  const requested = normalizeSourceTags(tags);
  if (mode === 'replace') {
    return requested;
  }
  if (mode === 'add') {
    return [...new Set([...current, ...requested])];
  }
  if (mode === 'remove') {
    const removed = new Set(requested);
    return current.filter((tag) => !removed.has(tag));
  }
  throw new SourceManagementError('invalid_tag_mode', 'tagMode must be add, remove, or replace');
}

function normalizeSourceIds(sourceIds, batchLimit) {
  if (!Array.isArray(sourceIds) || !sourceIds.length) {
    throw new SourceManagementError('invalid_source_ids', 'At least one sourceId is required');
  }
  const ids = [...new Set(sourceIds.map((sourceId) => String(sourceId).trim()).filter(Boolean))];
  if (!ids.length) {
    throw new SourceManagementError('invalid_source_ids', 'At least one sourceId is required');
  }
  if (ids.length > batchLimit) {
    throw new SourceManagementError(
      'batch_too_large',
      `At most ${batchLimit} sources may be changed in one operation`
    );
  }
  return ids;
}

function serializeAuditSource(source) {
  if (!source) {
    return null;
  }
  return {
    sourceId: source.sourceId,
    enabled: source.enabled === true,
    tags: source.tags || [],
    settings: source.settings || {},
    settingsVersion: source.settingsVersion || 0
  };
}

export function createSourceManagementService({ store, config, now = () => new Date() }) {
  const batchLimit = config.sourceMutationBatchLimit || 25;

  async function findExactSources(sourceIds) {
    const ids = normalizeSourceIds(sourceIds, batchLimit);
    const sources = await store.listSources({ includeDisabled: true, sourceIds: ids });
    const byId = new Map(sources.map((source) => [source.sourceId, source]));
    const missingSourceIds = ids.filter((sourceId) => !byId.has(sourceId));
    return { ids, sources: ids.map((sourceId) => byId.get(sourceId)).filter(Boolean), missingSourceIds };
  }

  async function audit({ actor, action, before, after, metadata = {} }) {
    if (!store.appendSourceAudit) {
      return;
    }
    await store.appendSourceAudit({
      actor,
      action,
      sourceId: after?.sourceId || before?.sourceId || null,
      before: serializeAuditSource(before),
      after: serializeAuditSource(after),
      metadata,
      createdAt: now()
    });
  }

  async function getSourceSettings(sourceId) {
    const { sources, missingSourceIds } = await findExactSources([sourceId]);
    if (missingSourceIds.length) {
      return { status: 'not_found', sourceId: String(sourceId) };
    }
    return { status: 'ok', source: compactSource(sources[0], config) };
  }

  async function updateSourceSettings({
    sourceId,
    settings,
    expectedVersion,
    preview = false,
    actor = 'unknown'
  }) {
    const patch = normalizeSourceSettingsPatch(settings);
    const { sources, missingSourceIds } = await findExactSources([sourceId]);
    if (missingSourceIds.length) {
      return { status: 'not_found', sourceId: String(sourceId) };
    }
    const before = sources[0];
    if (expectedVersion !== undefined && expectedVersion !== null) {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw new SourceManagementError(
          'invalid_version',
          'expectedVersion must be a non-negative integer'
        );
      }
      if ((before.settingsVersion || 0) !== expectedVersion) {
        return {
          status: 'conflict',
          sourceId: String(sourceId),
          expectedVersion
        };
      }
    }
    const changed = Object.entries(patch).some(([key, value]) => before.settings?.[key] !== value);
    if (!changed) {
      return { status: 'unchanged', source: compactSource(before, config) };
    }
    const projected = {
      ...before,
      settings: { ...(before.settings || {}), ...patch },
      settingsVersion: (before.settingsVersion || 0) + 1
    };
    if (preview) {
      return {
        status: 'preview',
        before: compactSource(before, config),
        after: compactSource(projected, config)
      };
    }

    const updated = await store.updateSourceConfiguration(sourceId, {
      settings: patch,
      expectedVersion
    });
    if (!updated) {
      return {
        status: 'conflict',
        sourceId: String(sourceId),
        expectedVersion: expectedVersion ?? null
      };
    }
    await audit({ actor, action: 'update_settings', before, after: updated });
    return { status: 'updated', source: compactSource(updated, config) };
  }

  async function mutateSources({
    sourceIds,
    enabled,
    tags,
    tagMode = 'add',
    preview = false,
    confirmSensitive = false,
    actor = 'unknown',
    action
  }) {
    const { ids, sources, missingSourceIds } = await findExactSources(sourceIds);
    if (missingSourceIds.length) {
      return { status: 'not_found', missingSourceIds };
    }

    const sensitiveSources = enabled === true
      ? sources.filter((source) => !source.enabled && isSensitiveSource(source))
      : [];
    if (sensitiveSources.length && !confirmSensitive) {
      return {
        status: 'confirmation_required',
        reason: 'Enabling direct or private Telegram sources requires explicit confirmation.',
        sources: sensitiveSources.map((source) => compactSource(source, config))
      };
    }

    const changes = sources.map((source) => {
      const nextTags = tags === undefined
        ? source.tags || []
        : applyTagMode(source.tags || [], tags, tagMode);
      const nextEnabled = enabled === undefined ? source.enabled : enabled;
      const changed = source.enabled !== nextEnabled
        || JSON.stringify(source.tags || []) !== JSON.stringify(nextTags);
      return {
        before: source,
        changed,
        projected: {
          ...source,
          ...(enabled === undefined ? {} : { enabled: nextEnabled }),
          tags: nextTags,
          settingsVersion: (source.settingsVersion || 0) + (changed ? 1 : 0)
        },
        nextTags
      };
    });

    if (preview) {
      return {
        status: 'preview',
        sourceIds: ids,
        changes: changes.map(({ before, projected }) => ({
          before: compactSource(before, config),
          after: compactSource(projected, config)
        }))
      };
    }

    const updatedSources = [];
    for (const change of changes) {
      if (!change.changed) {
        updatedSources.push(compactSource(change.before, config));
        continue;
      }
      const updated = await store.updateSourceConfiguration(change.before.sourceId, {
        ...(enabled === undefined ? {} : { enabled }),
        ...(tags === undefined ? {} : { tags: change.nextTags })
      });
      if (!updated) {
        throw new SourceManagementError(
          'source_update_failed',
          `Source changed while applying batch: ${change.before.sourceId}`
        );
      }
      await audit({ actor, action, before: change.before, after: updated, metadata: { tagMode } });
      updatedSources.push(compactSource(updated, config));
    }

    return {
      status: changes.some((change) => change.changed) ? 'updated' : 'unchanged',
      sources: updatedSources
    };
  }

  return {
    getSourceSettings,
    updateSourceSettings,
    enableSources: (args) => mutateSources({ ...args, enabled: true, action: 'enable' }),
    disableSources: (args) => mutateSources({ ...args, enabled: false, action: 'disable' }),
    setSourceTags: (args) => mutateSources({ ...args, enabled: undefined, action: 'set_tags' })
  };
}
