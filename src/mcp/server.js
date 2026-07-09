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
  timelineLimit: z.number().int().min(1).max(200).optional().describe('Maximum timeline excerpt count. Defaults to 80.')
};

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
