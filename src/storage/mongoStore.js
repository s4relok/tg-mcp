import { MongoClient } from 'mongodb';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class MongoTelegramStore {
  constructor(db, client) {
    this.db = db;
    this.client = client;
    this.sources = db.collection('tg_sources');
    this.messages = db.collection('tg_messages');
    this.digests = db.collection('tg_digests');
    this.syncState = db.collection('sync_state');
  }

  async ensureIndexes() {
    await Promise.all([
      this.sources.createIndex({ sourceId: 1 }, { unique: true }),
      this.sources.createIndex({ enabled: 1, tags: 1 }),
      this.messages.createIndex({ sourceId: 1, messageId: 1 }, { unique: true }),
      this.messages.createIndex({ sourceId: 1, date: -1 }),
      this.messages.createIndex({ date: -1 }),
      this.messages.createIndex({ text: 'text', senderName: 'text', link: 'text' }),
      this.digests.createIndex(
        { cacheKey: 1 },
        {
          unique: true,
          partialFilterExpression: { cacheKey: { $type: 'string' } }
        }
      ),
      this.digests.createIndex({ periodStart: 1, periodEnd: 1, sourceIds: 1 }),
      this.syncState.createIndex({ key: 1 }, { unique: true })
    ]);
  }

  async health() {
    await this.db.command({ ping: 1 });
    return { ok: true, driver: 'mongodb', database: this.db.databaseName };
  }

  async close() {
    await this.client.close();
  }

  async upsertSource(source, { preserveEnabled = false, preserveTags = true } = {}) {
    const now = new Date();
    const set = {
      ...source,
      updatedAt: now
    };

    if (preserveEnabled) {
      delete set.enabled;
    }
    if (preserveTags) {
      delete set.tags;
    }

    const setOnInsert = {
      createdAt: now
    };
    if (!Object.prototype.hasOwnProperty.call(set, 'enabled')) {
      setOnInsert.enabled = source.enabled ?? false;
    }
    if (!Object.prototype.hasOwnProperty.call(set, 'tags')) {
      setOnInsert.tags = source.tags || [];
    }

    await this.sources.updateOne(
      { sourceId: source.sourceId },
      {
        $set: set,
        $setOnInsert: setOnInsert
      },
      { upsert: true }
    );
  }

  async setSourceEnabled(sourceId, enabled) {
    const result = await this.sources.findOneAndUpdate(
      { sourceId },
      {
        $set: {
          enabled,
          updatedAt: new Date()
        }
      },
      {
        returnDocument: 'after'
      }
    );

    return result;
  }

  async setSourceTags(sourceId, tags) {
    const normalizedTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    const result = await this.sources.findOneAndUpdate(
      { sourceId },
      {
        $set: {
          tags: normalizedTags,
          updatedAt: new Date()
        }
      },
      {
        returnDocument: 'after'
      }
    );

    return result;
  }

  async markSourceSynced(sourceId, { lastSyncedMessageId = null, messageCount = 0 } = {}) {
    const now = new Date();
    const update = {
      $set: {
        lastSyncedAt: now,
        lastSyncMessageCount: messageCount,
        updatedAt: now
      }
    };

    if (lastSyncedMessageId !== null && lastSyncedMessageId !== undefined) {
      update.$max = {
        lastSyncedMessageId
      };
    }

    const result = await this.sources.findOneAndUpdate(
      { sourceId },
      update,
      {
        returnDocument: 'after'
      }
    );

    return result;
  }

  async upsertMessages(messages) {
    if (!messages.length) {
      return { insertedOrUpdated: 0 };
    }

    const now = new Date();
    const operations = messages.map((message) => ({
      updateOne: {
        filter: {
          sourceId: message.sourceId,
          messageId: message.messageId
        },
        update: {
          $set: {
            ...message,
            updatedAt: now
          },
          $setOnInsert: {
            createdAt: now
          }
        },
        upsert: true
      }
    }));

    const result = await this.messages.bulkWrite(operations, { ordered: false });
    return {
      insertedOrUpdated: result.upsertedCount + result.modifiedCount + result.matchedCount
    };
  }

  async listSources({ includeDisabled = false, sourceIds = [], tags = [], sourceQuery = '' } = {}) {
    const filter = {};
    if (!includeDisabled) {
      filter.enabled = true;
    }
    if (sourceIds.length) {
      filter.sourceId = { $in: sourceIds };
    }
    if (tags.length) {
      filter.tags = { $in: tags };
    }
    if (sourceQuery.trim()) {
      const pattern = new RegExp(escapeRegex(sourceQuery.trim()), 'i');
      filter.$or = [
        { sourceId: pattern },
        { title: pattern },
        { username: pattern },
        { tags: pattern }
      ];
    }

    return this.sources
      .find(filter)
      .sort({ title: 1 })
      .toArray();
  }

  async resolveSourceIds({ sourceIds = [], tags = [], sourceQuery = '', includeDisabled = false } = {}) {
    const sources = await this.listSources({ sourceIds, tags, sourceQuery, includeDisabled });
    return sources.map((source) => source.sourceId);
  }

  async findMessages({
    from,
    to,
    sourceIds = [],
    tags = [],
    sourceQuery = '',
    query = '',
    limit = 100,
    sort = 'desc'
  } = {}) {
    const resolvedSourceIds = await this.resolveSourceIds({ sourceIds, tags, sourceQuery });
    if (resolvedSourceIds.length === 0) {
      return [];
    }

    const filter = {
      sourceId: { $in: resolvedSourceIds }
    };

    if (from || to) {
      filter.date = {};
      if (from) {
        filter.date.$gte = new Date(from);
      }
      if (to) {
        filter.date.$lt = new Date(to);
      }
    }

    const projection = {};
    const trimmedQuery = query.trim();
    let cursor;

    if (trimmedQuery) {
      filter.$text = { $search: trimmedQuery };
      projection.score = { $meta: 'textScore' };
      cursor = this.messages
        .find(filter, { projection })
        .sort({ score: { $meta: 'textScore' }, date: -1 });
    } else {
      cursor = this.messages
        .find(filter)
        .sort({ date: sort === 'asc' ? 1 : -1 });
    }

    return cursor.limit(Math.min(limit, 500)).toArray();
  }

  async getMessageContext({ sourceId, messageId, before = 5, after = 5 }) {
    const target = await this.messages.findOne({ sourceId, messageId });
    if (!target) {
      return null;
    }

    const beforeMessages = await this.messages
      .find({ sourceId, messageId: { $lt: messageId } })
      .sort({ messageId: -1 })
      .limit(Math.min(before, 50))
      .toArray();

    const afterMessages = await this.messages
      .find({ sourceId, messageId: { $gt: messageId } })
      .sort({ messageId: 1 })
      .limit(Math.min(after, 50))
      .toArray();

    return {
      target,
      before: beforeMessages.reverse(),
      after: afterMessages
    };
  }

  async findDigest(cacheKey) {
    if (!cacheKey) {
      return null;
    }

    return this.digests.findOne({ cacheKey }, { projection: { _id: 0 } });
  }

  async saveDigest(digest) {
    const now = new Date();
    await this.digests.updateOne(
      {
        cacheKey: digest.cacheKey
      },
      {
        $set: {
          ...digest,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );
  }
}

export async function createMongoStore(config) {
  const client = new MongoClient(config.mongoUrl, {
    serverSelectionTimeoutMS: config.mongoServerSelectionTimeoutMs
  });
  try {
    await client.connect();
    const store = new MongoTelegramStore(client.db(config.mongoDb), client);
    await store.ensureIndexes();
    return store;
  } catch (caught) {
    await client.close(true);
    throw caught;
  }
}
