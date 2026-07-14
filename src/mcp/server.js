import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { createOAuthChallenge, OAuthScopes } from '../http/oauth.js';

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

function oauthToolMetadata(access, scopes) {
  if (!access.oauth) {
    return {};
  }
  return {
    _meta: {
      securitySchemes: [
        {
          type: 'oauth2',
          scopes
        }
      ]
    }
  };
}

function toolAuthorizationError(config, scopes, hasToken) {
  const error = hasToken ? 'insufficient_scope' : 'invalid_token';
  const description = hasToken
    ? `This operation requires: ${scopes.join(' ')}`
    : 'Sign in to use this operation.';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: description
      }
    ],
    _meta: {
      'mcp/www_authenticate': [createOAuthChallenge(config, scopes, { error, description })]
    }
  };
}

async function runAuthorizedTool({ access, config, extra, scopes, run }) {
  if (!access.oauth) {
    return run();
  }
  const authInfo = extra && extra.authInfo;
  const grantedScopes = new Set(authInfo ? authInfo.scopes : []);
  if (!authInfo || !scopes.every((scope) => grantedScopes.has(scope))) {
    return toolAuthorizationError(config, scopes, Boolean(authInfo));
  }
  return run();
}

function actorForAccess(access, extra) {
  if (!access.oauth) {
    return access.actor || 'mcp:owner';
  }
  const authInfo = extra && extra.authInfo;
  const subject = authInfo && authInfo.extra && typeof authInfo.extra.subject === 'string'
    ? authInfo.extra.subject
    : 'unknown';
  return `mcp:oauth:${subject}`;
}

function exposeTopLevelSecuritySchemes(server) {
  const protocol = server.server;
  const handlers = protocol && protocol._requestHandlers;
  const originalHandler = handlers && handlers.get('tools/list');
  if (!originalHandler) {
    return;
  }

  handlers.set('tools/list', async (request, extra) => {
    const result = await originalHandler(request, extra);
    return {
      ...result,
      tools: result.tools.map((tool) => {
        const securitySchemes = tool._meta && tool._meta.securitySchemes;
        return securitySchemes
          ? { ...tool, securitySchemes }
          : tool;
      })
    };
  });
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

const sourceSettingsPatchSchema = z.object({
  syncIntervalSeconds: z.number().int().min(60).max(7 * 24 * 60 * 60).nullable().optional()
    .describe('Per-source sync interval in seconds. Null inherits the server default.'),
  historyDepthDays: z.number().int().min(1).max(3650).nullable().optional()
    .describe('Maximum initial sync/backfill history depth in days. This is not data retention.'),
  includeMedia: z.boolean().optional()
    .describe('Store supported media metadata and queue supported audio for transcription.'),
  includeReplies: z.boolean().optional().describe('Include messages that reply to another message.'),
  includeForwardedPosts: z.boolean().optional().describe('Include forwarded Telegram messages.'),
  priority: z.number().int().min(0).max(100).nullable().optional()
    .describe('Scheduler priority. Higher values run first when several sources are due.')
}).strict();

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
        'If the user asks about voice notes, audio recordings, or spoken conversations, also call get_audio_transcription_status with the same filters and mention pending or failed transcripts.',
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
        'If the query may refer to voice notes, audio recordings, or spoken conversations, also call get_audio_transcription_status and mention pending or failed transcripts.',
        'Then call search_telegram_messages. When a hit looks important or ambiguous, call get_message_context for surrounding messages.',
        'Group results by practical topic and include direct Telegram links when available.',
        `Query: ${query}`,
        `Timezone: ${timezone || 'Europe/Chisinau'}${formatOptionalLine('From', from)}${formatOptionalLine('To', to)}${formatOptionalLine('Source filter', sourceQuery)}`
      ].join('\n')
    )
  );
}

export function createTelegramMcpServer({
  digestService,
  config,
  sourceManagementService,
  syncCoordinator,
  access = {}
}) {
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
        ...(access.allowDisabledSources
          ? { includeDisabled: z.boolean().optional().describe('Include disabled sources visible to the owner.') }
          : {}),
        ...sourceFilterSchema
      },
      annotations: {
        readOnlyHint: true
      },
      ...oauthToolMetadata(access, [OAuthScopes.read])
    },
    async (args, extra) => runAuthorizedTool({
      access,
      config,
      extra,
      scopes: args.includeDisabled === true
        ? [OAuthScopes.read, OAuthScopes.sourcesRead]
        : [OAuthScopes.read],
      run: async () => toolResult(await digestService.listSources({
        ...args,
        includeDisabled: access.allowDisabledSources && args.includeDisabled === true
      }))
    })
  );

  server.registerTool(
    'get_sync_status',
    {
      title: 'Get Telegram sync status',
      description: 'Check whether selected Telegram sources have fresh synced data before summarizing or searching.',
      inputSchema: {
        ...(access.allowDisabledSources
          ? { includeDisabled: z.boolean().optional().describe('Include disabled sources visible to the owner.') }
          : {}),
        staleAfterHours: z.number().int().min(1).max(168).optional().describe('Mark sources stale after this many hours. Defaults to 24.'),
        ...sourceFilterSchema
      },
      annotations: {
        readOnlyHint: true
      },
      ...oauthToolMetadata(access, [OAuthScopes.read])
    },
    async (args, extra) => runAuthorizedTool({
      access,
      config,
      extra,
      scopes: args.includeDisabled === true
        ? [OAuthScopes.read, OAuthScopes.sourcesRead]
        : [OAuthScopes.read],
      run: async () => toolResult(await digestService.getSyncStatus({
        ...args,
        includeDisabled: access.allowDisabledSources && args.includeDisabled === true
      }))
    })
  );

  server.registerTool(
    'get_audio_transcription_status',
    {
      title: 'Get Telegram audio transcription status',
      description: 'Count selected Telegram voice/audio messages by transcription status before searching or summarizing recordings.',
      inputSchema: {
        ...sourceFilterSchema
      },
      annotations: {
        readOnlyHint: true
      },
      ...oauthToolMetadata(access, [OAuthScopes.read])
    },
    async (args, extra) => runAuthorizedTool({
      access,
      config,
      extra,
      scopes: [OAuthScopes.read],
      run: async () => toolResult(await digestService.getAudioTranscriptionStatus(args))
    })
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
      },
      ...oauthToolMetadata(access, [OAuthScopes.read])
    },
    async (args, extra) => runAuthorizedTool({
      access,
      config,
      extra,
      scopes: [OAuthScopes.read],
      run: async () => toolResult(await digestService.getDailyDigest(args))
    })
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
      },
      ...oauthToolMetadata(access, [OAuthScopes.read])
    },
    async (args, extra) => runAuthorizedTool({
      access,
      config,
      extra,
      scopes: [OAuthScopes.read],
      run: async () => toolResult(await digestService.getPeriodSummary(args))
    })
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
      },
      ...oauthToolMetadata(access, [OAuthScopes.read])
    },
    async (args, extra) => runAuthorizedTool({
      access,
      config,
      extra,
      scopes: [OAuthScopes.read],
      run: async () => toolResult(await digestService.getSourceSummary(args))
    })
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
      },
      ...oauthToolMetadata(access, [OAuthScopes.read])
    },
    async (args, extra) => runAuthorizedTool({
      access,
      config,
      extra,
      scopes: [OAuthScopes.read],
      run: async () => toolResult(await digestService.searchMessages(args))
    })
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
      },
      ...oauthToolMetadata(access, [OAuthScopes.read])
    },
    async (args, extra) => runAuthorizedTool({
      access,
      config,
      extra,
      scopes: [OAuthScopes.read],
      run: async () => toolResult(await digestService.getMessageContext(args))
    })
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
      },
      ...oauthToolMetadata(access, [OAuthScopes.read])
    },
    async (args, extra) => runAuthorizedTool({
      access,
      config,
      extra,
      scopes: [OAuthScopes.read],
      run: async () => toolResult(await digestService.getActionItems(args))
    })
  );

  if (access.manageSources && sourceManagementService) {
    const sourceIdsSchema = z.array(z.string().min(1))
      .min(1)
      .max(config.sourceMutationBatchLimit || 25)
      .describe('Exact Telegram source ids. Use list_sources first; broad wildcard mutations are not allowed.');
    const mutationOptionsSchema = {
      sourceIds: sourceIdsSchema,
      preview: z.boolean().optional().describe('Return the exact before/after change without applying it.')
    };

    server.registerTool(
      'get_source_settings',
      {
        title: 'Get Telegram source settings',
        description: 'Read stored and effective settings for one Telegram source visible to the authenticated owner.',
        inputSchema: {
          sourceId: z.string().min(1).describe('Exact Telegram source id.')
        },
        annotations: {
          readOnlyHint: true
        },
        ...oauthToolMetadata(access, [OAuthScopes.read, OAuthScopes.sourcesRead])
      },
      async ({ sourceId }, extra) => runAuthorizedTool({
        access,
        config,
        extra,
        scopes: [OAuthScopes.read, OAuthScopes.sourcesRead],
        run: async () => toolResult(await sourceManagementService.getSourceSettings(sourceId))
      })
    );

    server.registerTool(
      'update_source_settings',
      {
        title: 'Update Telegram source settings',
        description: 'Patch scheduler and ingestion settings for one Telegram source. Omitted fields are unchanged.',
        inputSchema: {
          sourceId: z.string().min(1).describe('Exact Telegram source id.'),
          settings: sourceSettingsPatchSchema,
          expectedVersion: z.number().int().min(0).optional()
            .describe('Optional optimistic concurrency version from get_source_settings.'),
          preview: z.boolean().optional().describe('Return the before/after change without applying it.')
        },
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          destructiveHint: true
        },
        ...oauthToolMetadata(access, [
          OAuthScopes.read,
          OAuthScopes.sourcesRead,
          OAuthScopes.sourcesManage
        ])
      },
      async (args, extra) => runAuthorizedTool({
        access,
        config,
        extra,
        scopes: [OAuthScopes.read, OAuthScopes.sourcesRead, OAuthScopes.sourcesManage],
        run: async () => toolResult(await sourceManagementService.updateSourceSettings({
          ...args,
          actor: actorForAccess(access, extra)
        }))
      })
    );

    server.registerTool(
      'enable_source',
      {
        title: 'Enable Telegram sources',
        description: 'Enable an exact bounded list of Telegram sources. Direct/private sources require confirmSensitive=true.',
        inputSchema: {
          ...mutationOptionsSchema,
          tags: z.array(z.string()).optional().describe('Tags to add while enabling.'),
          confirmSensitive: z.boolean().optional()
            .describe('Explicitly confirm enabling direct or private Telegram sources.')
        },
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          destructiveHint: false
        },
        ...oauthToolMetadata(access, [
          OAuthScopes.read,
          OAuthScopes.sourcesRead,
          OAuthScopes.sourcesManage
        ])
      },
      async (args, extra) => runAuthorizedTool({
        access,
        config,
        extra,
        scopes: [OAuthScopes.read, OAuthScopes.sourcesRead, OAuthScopes.sourcesManage],
        run: async () => toolResult(await sourceManagementService.enableSources({
          ...args,
          tagMode: 'add',
          actor: actorForAccess(access, extra)
        }))
      })
    );

    server.registerTool(
      'disable_source',
      {
        title: 'Disable Telegram sources',
        description: 'Stop future synchronization and exclude exact sources from search and digests. Existing stored messages are not deleted.',
        inputSchema: mutationOptionsSchema,
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          destructiveHint: true
        },
        ...oauthToolMetadata(access, [
          OAuthScopes.read,
          OAuthScopes.sourcesRead,
          OAuthScopes.sourcesManage
        ])
      },
      async (args, extra) => runAuthorizedTool({
        access,
        config,
        extra,
        scopes: [OAuthScopes.read, OAuthScopes.sourcesRead, OAuthScopes.sourcesManage],
        run: async () => toolResult(await sourceManagementService.disableSources({
          ...args,
          actor: actorForAccess(access, extra)
        }))
      })
    );

    server.registerTool(
      'set_source_tags',
      {
        title: 'Set Telegram source tags',
        description: 'Add, remove, or replace tags on an exact bounded list of Telegram sources.',
        inputSchema: {
          ...mutationOptionsSchema,
          tags: z.array(z.string()).describe('Tags to add, remove, or use as the replacement set.'),
          tagMode: z.enum(['add', 'remove', 'replace']).default('add')
            .describe('Tag mutation mode. Defaults to add so existing tags are preserved.')
        },
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          destructiveHint: true
        },
        ...oauthToolMetadata(access, [
          OAuthScopes.read,
          OAuthScopes.sourcesRead,
          OAuthScopes.sourcesManage
        ])
      },
      async (args, extra) => runAuthorizedTool({
        access,
        config,
        extra,
        scopes: [OAuthScopes.read, OAuthScopes.sourcesRead, OAuthScopes.sourcesManage],
        run: async () => toolResult(await sourceManagementService.setSourceTags({
          ...args,
          actor: actorForAccess(access, extra)
        }))
      })
    );
  }

  if (access.runSourceSync && syncCoordinator) {
    server.registerTool(
      'sync_source',
      {
        title: 'Synchronize Telegram sources now',
        description: 'Run a bounded sync for exact enabled source ids. Disabled sources and ids outside ALLOWED_SOURCE_IDS are rejected.',
        inputSchema: {
          sourceIds: z.array(z.string().min(1)).min(1).max(config.sourceMutationBatchLimit || 25),
          limit: z.number().int().min(1).max(config.telegramSyncMaxLimit || 1000).optional(),
          backfillDays: z.number().int().min(1).max(3650).optional()
            .describe('Optional historical import depth, clamped to each source historyDepthDays setting.')
        },
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          destructiveHint: false,
          openWorldHint: true
        },
        ...oauthToolMetadata(access, [OAuthScopes.read, OAuthScopes.syncRun])
      },
      async (args, extra) => runAuthorizedTool({
        access,
        config,
        extra,
        scopes: [OAuthScopes.read, OAuthScopes.syncRun],
        run: async () => toolResult(await syncCoordinator.run({
          ...args,
          reason: 'mcp',
          actor: actorForAccess(access, extra)
        }))
      })
    );
  }

  // MCP SDK 1.29 preserves extension metadata but does not yet emit the
  // top-level securitySchemes field documented by OpenAI. Mirror the same
  // schemes onto the wire while retaining _meta for older clients.
  if (access.oauth) {
    exposeTopLevelSecuritySchemes(server);
  }

  return server;
}
