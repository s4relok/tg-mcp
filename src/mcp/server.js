import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

function toolResult(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data
  };
}

const sourceFilterSchema = {
  sourceIds: z.array(z.string()).optional().describe('Optional Telegram source ids to include.'),
  tags: z.array(z.string()).optional().describe('Optional source tags to include.'),
  sourceQuery: z.string().optional().describe('Optional case-insensitive source lookup by title, username, id, or tag.')
};

const digestExcerptSchema = {
  includeTimeline: z.boolean().optional().describe('Include compact chronological message excerpts. Defaults to true.'),
  timelineLimit: z.number().int().min(1).max(200).optional().describe('Maximum timeline excerpt count. Defaults to 80.'),
  refresh: z.boolean().optional().describe('Bypass the digest cache and recompute from stored Telegram messages.')
};

function promptMessage(text) {
  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text
        }
      }
    ]
  };
}

function formatOptionalLine(label, value) {
  return value ? `\n${label}: ${value}` : '';
}

function registerTelegramPrompts(server) {
  server.registerPrompt(
    'daily_telegram_digest',
    {
      title: 'Daily Telegram digest',
      description: 'Prepare a practical digest for selected Telegram chats/channels.',
      argsSchema: {
        date: z.string().optional().describe('Date in YYYY-MM-DD format. Defaults to today.'),
        timezone: z.string().optional().describe('IANA timezone. Defaults to Europe/Chisinau.'),
        sourceQuery: z.string().optional().describe('Optional source lookup by title, username, id, or tag.')
      }
    },
    async ({ date, timezone, sourceQuery }) => promptMessage(
      [
        'Create a concise Telegram digest for the selected chats/channels.',
        'First call get_sync_status with the same filters. If data is missing, never synced, or stale, say that before summarizing.',
        'Then call get_daily_digest. Prioritize decisions, blockers, important updates, unanswered questions, links, and action items.',
        'Do not paste a raw chat log unless the user asks for details.',
        `Date: ${date || 'today'}`,
        `Timezone: ${timezone || 'Europe/Chisinau'}${formatOptionalLine('Source filter', sourceQuery)}`
      ].join('\n')
    )
  );

  server.registerPrompt(
    'search_telegram',
    {
      title: 'Search Telegram',
      description: 'Search selected Telegram chats/channels and summarize the useful context.',
      argsSchema: {
        query: z.string().describe('Topic, person, project, link, bug, decision, or discussion to search for.'),
        from: z.string().optional().describe('Start date in YYYY-MM-DD format, inclusive.'),
        to: z.string().optional().describe('End date in YYYY-MM-DD format, exclusive.'),
        timezone: z.string().optional().describe('IANA timezone. Defaults to Europe/Chisinau.'),
        sourceQuery: z.string().optional().describe('Optional source lookup by title, username, id, or tag.')
      }
    },
    async ({ query, from, to, timezone, sourceQuery }) => promptMessage(
      [
        'Search selected Telegram chats/channels and summarize the useful findings.',
        'First call get_sync_status with the same source filter. If data is missing, never synced, or stale, mention that limitation.',
        'Then call search_telegram_messages. When a hit looks important or ambiguous, call get_message_context for surrounding messages.',
        'Group results by practical topic and include direct Telegram links when available.',
        `Query: ${query}`,
        `Timezone: ${timezone || 'Europe/Chisinau'}${formatOptionalLine('From', from)}${formatOptionalLine('To', to)}${formatOptionalLine('Source filter', sourceQuery)}`
      ].join('\n')
    )
  );
}

export function createTelegramMcpServer({ digestService, config }) {
  const server = new McpServer(
    {
      name: 'tg-mcp',
      version: '0.1.0',
      websiteUrl: config.publicBaseUrl
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  registerTelegramPrompts(server);

  server.registerTool(
    'list_sources',
    {
      title: 'List Telegram sources',
      description: 'List selected Telegram chats/channels available to this MCP server.',
      inputSchema: {
        includeDisabled: z.boolean().optional().describe('Include disabled sources.'),
        ...sourceFilterSchema
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async (args) => toolResult(await digestService.listSources(args))
  );

  server.registerTool(
    'get_sync_status',
    {
      title: 'Get Telegram sync status',
      description: 'Check whether selected Telegram sources have fresh synced data before summarizing or searching.',
      inputSchema: {
        includeDisabled: z.boolean().optional().describe('Include disabled sources.'),
        staleAfterHours: z.number().int().min(1).max(168).optional().describe('Mark sources stale after this many hours. Defaults to 24.'),
        ...sourceFilterSchema
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async (args) => toolResult(await digestService.getSyncStatus(args))
  );

  server.registerTool(
    'get_daily_digest',
    {
      title: 'Get daily Telegram digest',
      description: 'Summarize selected Telegram chats/channels for a specific local date.',
      inputSchema: {
        date: z.string().optional().describe('Date in YYYY-MM-DD format. Defaults to today in the provided timezone.'),
        timezone: z.string().optional().describe('IANA timezone. Defaults to Europe/Chisinau.'),
        ...digestExcerptSchema,
        ...sourceFilterSchema
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async (args) => toolResult(await digestService.getDailyDigest(args))
  );

  server.registerTool(
    'get_period_summary',
    {
      title: 'Get Telegram period summary',
      description: 'Summarize selected Telegram chats/channels for a custom date range.',
      inputSchema: {
        from: z.string().describe('Start date in YYYY-MM-DD format, inclusive.'),
        to: z.string().describe('End date in YYYY-MM-DD format, exclusive.'),
        timezone: z.string().optional().describe('IANA timezone. Defaults to Europe/Chisinau.'),
        ...digestExcerptSchema,
        ...sourceFilterSchema
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async (args) => toolResult(await digestService.getPeriodSummary(args))
  );

  server.registerTool(
    'get_source_summary',
    {
      title: 'Get Telegram source summary',
      description: 'Summarize one selected Telegram chat/channel for a date or date range.',
      inputSchema: {
        sourceId: z.string().describe('Telegram source id to summarize.'),
        date: z.string().optional().describe('Date in YYYY-MM-DD format. Used when from/to are not provided. Defaults to today.'),
        from: z.string().optional().describe('Start date in YYYY-MM-DD format, inclusive.'),
        to: z.string().optional().describe('End date in YYYY-MM-DD format, exclusive.'),
        timezone: z.string().optional().describe('IANA timezone. Defaults to Europe/Chisinau.'),
        ...digestExcerptSchema
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async (args) => toolResult(await digestService.getSourceSummary(args))
  );

  server.registerTool(
    'search_telegram_messages',
    {
      title: 'Search Telegram messages',
      description: 'Search selected Telegram chats/channels by topic, person, link, bug, file, or discussion.',
      inputSchema: {
        query: z.string().min(1).describe('Search query.'),
        from: z.string().optional().describe('Start date in YYYY-MM-DD format, inclusive.'),
        to: z.string().optional().describe('End date in YYYY-MM-DD format, exclusive.'),
        timezone: z.string().optional().describe('IANA timezone. Defaults to Europe/Chisinau.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum result count.'),
        ...sourceFilterSchema
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async (args) => toolResult(await digestService.searchMessages(args))
  );

  server.registerTool(
    'get_message_context',
    {
      title: 'Get Telegram message context',
      description: 'Return messages around a selected Telegram message.',
      inputSchema: {
        sourceId: z.string().describe('Telegram source id.'),
        messageId: z.number().int().describe('Telegram message id.'),
        before: z.number().int().min(0).max(50).optional().describe('Messages before the target.'),
        after: z.number().int().min(0).max(50).optional().describe('Messages after the target.')
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async (args) => toolResult(await digestService.getMessageContext(args))
  );

  server.registerTool(
    'get_action_items',
    {
      title: 'Get Telegram action items',
      description: 'Find messages that look like open questions or action candidates.',
      inputSchema: {
        from: z.string().optional().describe('Start date in YYYY-MM-DD format, inclusive. Defaults to today.'),
        to: z.string().optional().describe('End date in YYYY-MM-DD format, exclusive. Defaults to tomorrow.'),
        timezone: z.string().optional().describe('IANA timezone. Defaults to Europe/Chisinau.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum action item count.'),
        ...sourceFilterSchema
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async (args) => toolResult(await digestService.getActionItems(args))
  );

  return server;
}
