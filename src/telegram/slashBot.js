import { Bot } from 'grammy';

const MAX_TELEGRAM_MESSAGE_LENGTH = 3900;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_ACTION_LIMIT = 10;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const COMMANDS = [
  { command: 'digest_today', description: 'Today digest for selected Telegram sources' },
  { command: 'digest_week', description: 'Last 7 days digest' },
  { command: 'search', description: 'Search selected Telegram sources' },
  { command: 'actions', description: 'Action-like messages and open questions' },
  { command: 'sources', description: 'List enabled Telegram sources' },
  { command: 'help', description: 'Show commands' }
];

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(value, max = 180) {
  const text = cleanText(value);
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

function sourceLabel(item) {
  return item.sourceTitle || item.title || item.sourceId || 'unknown source';
}

function senderLabel(item) {
  return item.senderName ? `${item.senderName}: ` : '';
}

function messageLine(item) {
  const body = truncate(item.text || '(no text)');
  const link = item.link ? ` ${item.link}` : '';
  return `- ${sourceLabel(item)} #${item.messageId}: ${senderLabel(item)}${body}${link}`;
}

function limitTelegramText(text) {
  if (text.length <= MAX_TELEGRAM_MESSAGE_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_TELEGRAM_MESSAGE_LENGTH - 15)}\n...truncated`;
}

function commandArg(ctx) {
  if (typeof ctx.match === 'string') {
    return ctx.match.trim();
  }

  const text = ctx.message?.text || '';
  const firstSpace = text.indexOf(' ');
  return firstSpace >= 0 ? text.slice(firstSpace + 1).trim() : '';
}

function periodFromLastWeek(now = new Date()) {
  const to = now;
  const from = new Date(to.getTime() - WEEK_MS);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10)
  };
}

export function isTelegramBotChatAllowed(config, ctx) {
  const allowedChatIds = config.telegramBotAllowedChatIds || [];
  if (!allowedChatIds.length) {
    return true;
  }

  const chatId = ctx.chat?.id ?? ctx.message?.chat?.id ?? ctx.update?.message?.chat?.id;
  return allowedChatIds.includes(String(chatId));
}

export function formatHelp() {
  return [
    'tg-mcp commands:',
    '/digest_today [source]',
    '/digest_week [source]',
    '/search <query>',
    '/actions [source]',
    '/sources [query]',
    '',
    'The bot is read-only and uses the same selected Telegram data as MCP.'
  ].join('\n');
}

export function formatDigest(digest, { title = 'Telegram digest' } = {}) {
  const lines = [
    title,
    digest.summary,
    `Messages: ${digest.messageCount}`,
    `Period: ${digest.periodStart} - ${digest.periodEnd}`
  ];

  if (digest.sources?.length) {
    lines.push('', 'Sources:');
    for (const source of digest.sources.slice(0, 8)) {
      lines.push(`- ${source.title}: ${source.messageCount}`);
    }
  }

  if (digest.decisions?.length) {
    lines.push('', 'Decisions:');
    for (const item of digest.decisions.slice(0, 5)) {
      lines.push(messageLine(item));
    }
  }

  if (digest.actionItems?.length) {
    lines.push('', 'Action candidates:');
    for (const item of digest.actionItems.slice(0, 5)) {
      lines.push(messageLine(item));
    }
  }

  if (digest.questions?.length) {
    lines.push('', 'Questions:');
    for (const item of digest.questions.slice(0, 5)) {
      lines.push(messageLine(item));
    }
  }

  if (digest.highlights?.length && !digest.decisions?.length && !digest.actionItems?.length) {
    lines.push('', 'Highlights:');
    for (const item of digest.highlights.slice(0, 5)) {
      lines.push(messageLine(item));
    }
  }

  if (digest.links?.length) {
    lines.push('', 'Links:');
    for (const item of digest.links.slice(0, 5)) {
      lines.push(`- ${item.url}`);
    }
  }

  return limitTelegramText(lines.join('\n'));
}

export function formatSearchResults(result) {
  const lines = [
    `Search: ${result.query}`,
    `Found: ${result.count}`
  ];

  if (!result.results?.length) {
    lines.push('', 'No messages found.');
    return lines.join('\n');
  }

  lines.push('');
  for (const item of result.results.slice(0, DEFAULT_SEARCH_LIMIT)) {
    lines.push(messageLine(item));
  }

  return limitTelegramText(lines.join('\n'));
}

export function formatActionItems(result) {
  const lines = [
    'Action candidates',
    `Found: ${result.count}`,
    `Period: ${result.periodStart} - ${result.periodEnd}`
  ];

  if (!result.actionItems?.length) {
    lines.push('', 'No action-like messages found.');
    return lines.join('\n');
  }

  lines.push('');
  for (const item of result.actionItems.slice(0, DEFAULT_ACTION_LIMIT)) {
    lines.push(`${messageLine(item)} (${item.reason})`);
  }

  return limitTelegramText(lines.join('\n'));
}

export function formatSources(result) {
  const lines = [`Enabled sources: ${result.sources.length}`];

  if (!result.sources.length) {
    lines.push('', 'No enabled sources found.');
    return lines.join('\n');
  }

  lines.push('');
  for (const source of result.sources.slice(0, 30)) {
    const tags = source.tags?.length ? ` [${source.tags.join(', ')}]` : '';
    const username = source.username ? ` @${source.username}` : '';
    lines.push(`- ${source.title}${username}${tags} (${source.sourceId})`);
  }

  return limitTelegramText(lines.join('\n'));
}

async function replyText(ctx, text) {
  await ctx.reply(limitTelegramText(text), {
    disable_web_page_preview: true
  });
}

export async function handleDigestToday(ctx, { digestService, config }) {
  const sourceQuery = commandArg(ctx);
  const digest = await digestService.getDailyDigest({
    timezone: config.telegramBotTimezone,
    sourceQuery,
    includeTimeline: false
  });

  const suffix = sourceQuery ? ` (${sourceQuery})` : '';
  await replyText(ctx, formatDigest(digest, { title: `Today Telegram digest${suffix}` }));
}

export async function handleDigestWeek(ctx, { digestService, config, now = new Date() }) {
  const sourceQuery = commandArg(ctx);
  const period = periodFromLastWeek(now);
  const digest = await digestService.getPeriodSummary({
    ...period,
    timezone: config.telegramBotTimezone,
    sourceQuery,
    includeTimeline: false
  });

  const suffix = sourceQuery ? ` (${sourceQuery})` : '';
  await replyText(ctx, formatDigest(digest, { title: `7 day Telegram digest${suffix}` }));
}

export async function handleSearch(ctx, { digestService, config }) {
  const query = commandArg(ctx);
  if (!query) {
    await replyText(ctx, 'Usage: /search <query>');
    return;
  }

  const result = await digestService.searchMessages({
    query,
    timezone: config.telegramBotTimezone,
    limit: DEFAULT_SEARCH_LIMIT
  });

  await replyText(ctx, formatSearchResults(result));
}

export async function handleActions(ctx, { digestService, config, from, to }) {
  const sourceQuery = commandArg(ctx);
  const result = await digestService.getActionItems({
    from,
    to,
    timezone: config.telegramBotTimezone,
    sourceQuery,
    limit: DEFAULT_ACTION_LIMIT
  });

  await replyText(ctx, formatActionItems(result));
}

export async function handleSources(ctx, { digestService }) {
  const sourceQuery = commandArg(ctx);
  const result = await digestService.listSources({ sourceQuery });
  await replyText(ctx, formatSources(result));
}

export function registerTelegramSlashCommands(bot, { config, digestService }) {
  bot.use(async (ctx, next) => {
    if (!isTelegramBotChatAllowed(config, ctx)) {
      await replyText(ctx, 'This Telegram chat is not allowed to use tg-mcp.');
      return;
    }
    await next();
  });

  bot.command(['start', 'help'], async (ctx) => replyText(ctx, formatHelp()));
  bot.command('digest_today', async (ctx) => handleDigestToday(ctx, { digestService, config }));
  bot.command('digest_week', async (ctx) => handleDigestWeek(ctx, { digestService, config }));
  bot.command('search', async (ctx) => handleSearch(ctx, { digestService, config }));
  bot.command('actions', async (ctx) => handleActions(ctx, { digestService, config }));
  bot.command('sources', async (ctx) => handleSources(ctx, { digestService, config }));

  return bot;
}

export function startTelegramSlashBot({ config, digestService, botFactory = (token) => new Bot(token) }) {
  if (!config.telegramBotEnabled) {
    return {
      enabled: false,
      stop: async () => {}
    };
  }

  if (!config.telegramBotToken) {
    console.warn('TELEGRAM_BOT_ENABLED is true but TELEGRAM_BOT_TOKEN is empty; slash bot is disabled.');
    return {
      enabled: false,
      stop: async () => {}
    };
  }

  const bot = registerTelegramSlashCommands(botFactory(config.telegramBotToken), {
    config,
    digestService
  });

  bot.catch((error) => {
    console.error('Telegram slash bot error:', error);
  });

  const startPromise = (async () => {
    await bot.api.setMyCommands(COMMANDS);
    await bot.start({
      onStart: (info) => {
        console.log(`tg-mcp Telegram slash bot started as @${info.username}`);
      }
    });
  })().catch((error) => {
    console.error('Telegram slash bot stopped after error:', error);
  });

  return {
    enabled: true,
    bot,
    stop: async () => {
      bot.stop();
      await startPromise;
    }
  };
}
