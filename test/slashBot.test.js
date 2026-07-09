import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatHelp,
  handleActions,
  handleDigestWeek,
  handleSearch,
  handleSources,
  isTelegramBotChatAllowed
} from '../src/telegram/slashBot.js';
import { createTelegramDigestService } from '../src/services/digestService.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function createFixtureService() {
  const store = new MemoryTelegramStore({
    sources: [
      { sourceId: 'chat-1', title: 'Project Chat', type: 'Channel', enabled: true, tags: ['work'] },
      { sourceId: 'chat-2', title: 'Archive Chat', type: 'Chat', enabled: true, tags: ['archive'] }
    ],
    messages: [
      {
        sourceId: 'chat-1',
        messageId: 1,
        date: '2026-07-09T06:00:00.000Z',
        senderName: 'Andrei',
        text: 'Decision: ship the digest MCP today.'
      },
      {
        sourceId: 'chat-1',
        messageId: 2,
        date: '2026-07-09T07:00:00.000Z',
        senderName: 'Mira',
        text: 'Need to check slash bot search before deploy?'
      },
      {
        sourceId: 'chat-2',
        messageId: 3,
        date: '2026-07-09T08:00:00.000Z',
        senderName: 'Noise',
        text: 'Archive note.'
      }
    ]
  });

  return createTelegramDigestService(store);
}

function createContext(match = '', chatId = 123) {
  return {
    match,
    chat: { id: chatId },
    replies: [],
    reply: async function reply(text, options) {
      this.replies.push({ text, options });
    }
  };
}

const config = {
  telegramBotTimezone: 'UTC',
  telegramBotAllowedChatIds: ['123']
};

test('isTelegramBotChatAllowed honors allowlist', () => {
  assert.equal(isTelegramBotChatAllowed(config, createContext('', 123)), true);
  assert.equal(isTelegramBotChatAllowed(config, createContext('', 999)), false);
  assert.equal(isTelegramBotChatAllowed({ telegramBotAllowedChatIds: [] }, createContext('', 999)), true);
});

test('formatHelp lists read-only slash commands', () => {
  const help = formatHelp();

  assert.match(help, /\/digest_today/);
  assert.match(help, /\/search <query>/);
  assert.match(help, /read-only/);
});

test('handleSearch replies with usage when query is missing', async () => {
  const ctx = createContext('');

  await handleSearch(ctx, { digestService: createFixtureService(), config });

  assert.equal(ctx.replies[0].text, 'Usage: /search <query>');
});

test('handleSearch returns compact search results', async () => {
  const ctx = createContext('slash bot');

  await handleSearch(ctx, { digestService: createFixtureService(), config });

  assert.match(ctx.replies[0].text, /Search: slash bot/);
  assert.match(ctx.replies[0].text, /Found: 1/);
  assert.match(ctx.replies[0].text, /Project Chat/);
  assert.equal(ctx.replies[0].options.disable_web_page_preview, true);
});

test('handleDigestWeek can filter by source query', async () => {
  const ctx = createContext('project');

  await handleDigestWeek(ctx, {
    digestService: createFixtureService(),
    config,
    now: new Date('2026-07-10T00:00:00.000Z')
  });

  assert.match(ctx.replies[0].text, /7 day Telegram digest \(project\)/);
  assert.match(ctx.replies[0].text, /Messages: 2/);
  assert.doesNotMatch(ctx.replies[0].text, /Archive Chat/);
});

test('handleActions supports optional source query', async () => {
  const ctx = createContext('project');

  await handleActions(ctx, {
    digestService: createFixtureService(),
    config,
    from: '2026-07-09',
    to: '2026-07-10'
  });

  assert.match(ctx.replies[0].text, /Action candidates/);
  assert.match(ctx.replies[0].text, /Project Chat/);
});

test('handleSources returns enabled source list', async () => {
  const ctx = createContext('archive');

  await handleSources(ctx, { digestService: createFixtureService(), config });

  assert.match(ctx.replies[0].text, /Enabled sources: 1/);
  assert.match(ctx.replies[0].text, /Archive Chat/);
});
