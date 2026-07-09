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

  async upsertSource(source) {
    const index = this.sources.findIndex((item) => item.sourceId === source.sourceId);
    if (index >= 0) {
      this.sources[index] = { ...this.sources[index], ...source };
      return;
    }
    this.sources.push({ enabled: true, tags: [], ...source });
  }

  async upsertMessages(messages) {
    for (const message of messages) {
      const index = this.messages.findIndex(
        (item) => item.sourceId === message.sourceId && item.messageId === message.messageId
      );
      const normalized = { ...message, date: new Date(message.date) };
      if (index >= 0) {
        this.messages[index] = { ...this.messages[index], ...normalized };
      } else {
        this.messages.push(normalized);
      }
    }

    return { insertedOrUpdated: messages.length };
  }

  async listSources({ includeDisabled = false, sourceIds = [], tags = [] } = {}) {
    return this.sources
      .filter((source) => includeDisabled || source.enabled)
      .filter((source) => !sourceIds.length || sourceIds.includes(source.sourceId))
      .filter((source) => !tags.length || tags.some((tag) => source.tags.includes(tag)))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async resolveSourceIds({ sourceIds = [], tags = [], includeDisabled = false } = {}) {
    const sources = await this.listSources({ sourceIds, tags, includeDisabled });
    return sources.map((source) => source.sourceId);
  }

  async findMessages({ from, to, sourceIds = [], tags = [], query = '', limit = 100, sort = 'desc' } = {}) {
    const resolvedSourceIds = await this.resolveSourceIds({ sourceIds, tags });
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
      .filter((message) => !lowerQuery || `${message.text || ''} ${message.senderName || ''} ${message.link || ''}`.toLowerCase().includes(lowerQuery))
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

  async saveDigest(digest) {
    this.savedDigests.push(digest);
  }
}
