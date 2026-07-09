function parameter(name, description, schema = { type: 'string' }) {
  return {
    name,
    in: 'query',
    required: false,
    description,
    schema
  };
}

const sourceFilterParameters = [
  parameter('sourceId', 'Telegram source id. Repeat or comma-separate for multiple values.'),
  parameter('tag', 'Source tag. Repeat or comma-separate for multiple values.')
];

function jsonResponse(description) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: true
        }
      }
    }
  };
}

export function createOpenApiDocument(config) {
  const api = config.restBasePath;
  return {
    openapi: '3.1.0',
    info: {
      title: 'Telegram Digest MCP Fallback API',
      version: '0.1.0',
      description: 'Read-only Telegram digest/search API over selected chats and channels.'
    },
    servers: [
      {
        url: config.publicBaseUrl
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer'
        }
      }
    },
    security: config.appAuthToken ? [{ bearerAuth: [] }] : [],
    paths: {
      [`${api}/sources`]: {
        get: {
          operationId: 'listSources',
          summary: 'List Telegram sources',
          parameters: [
            parameter('includeDisabled', 'Include disabled sources.', { type: 'boolean' }),
            ...sourceFilterParameters
          ],
          responses: {
            200: jsonResponse('Telegram sources.')
          }
        }
      },
      [`${api}/digest/daily`]: {
        get: {
          operationId: 'getDailyDigest',
          summary: 'Get a daily Telegram digest',
          parameters: [
            parameter('date', 'Date in YYYY-MM-DD format. Defaults to today.'),
            parameter('timezone', 'IANA timezone. Defaults to Europe/Chisinau.'),
            ...sourceFilterParameters
          ],
          responses: {
            200: jsonResponse('Daily digest.')
          }
        }
      },
      [`${api}/summary/period`]: {
        get: {
          operationId: 'getPeriodSummary',
          summary: 'Get Telegram summary for a date range',
          parameters: [
            { ...parameter('from', 'Start date in YYYY-MM-DD format, inclusive.'), required: true },
            { ...parameter('to', 'End date in YYYY-MM-DD format, exclusive.'), required: true },
            parameter('timezone', 'IANA timezone. Defaults to Europe/Chisinau.'),
            ...sourceFilterParameters
          ],
          responses: {
            200: jsonResponse('Period summary.')
          }
        }
      },
      [`${api}/search`]: {
        get: {
          operationId: 'searchTelegramMessages',
          summary: 'Search Telegram messages',
          parameters: [
            { ...parameter('query', 'Search query.'), required: true },
            parameter('from', 'Start date in YYYY-MM-DD format, inclusive.'),
            parameter('to', 'End date in YYYY-MM-DD format, exclusive.'),
            parameter('timezone', 'IANA timezone. Defaults to Europe/Chisinau.'),
            parameter('limit', 'Maximum result count.', { type: 'integer', minimum: 1, maximum: 100 }),
            ...sourceFilterParameters
          ],
          responses: {
            200: jsonResponse('Search results.')
          }
        }
      },
      [`${api}/messages/context`]: {
        get: {
          operationId: 'getMessageContext',
          summary: 'Get Telegram message context',
          parameters: [
            { ...parameter('sourceId', 'Telegram source id.'), required: true },
            { ...parameter('messageId', 'Telegram message id.', { type: 'integer' }), required: true },
            parameter('before', 'Messages before target.', { type: 'integer', minimum: 0, maximum: 50 }),
            parameter('after', 'Messages after target.', { type: 'integer', minimum: 0, maximum: 50 })
          ],
          responses: {
            200: jsonResponse('Message context.')
          }
        }
      },
      [`${api}/actions`]: {
        get: {
          operationId: 'getActionItems',
          summary: 'Get action-like Telegram messages',
          parameters: [
            parameter('from', 'Start date in YYYY-MM-DD format, inclusive. Defaults to today.'),
            parameter('to', 'End date in YYYY-MM-DD format, exclusive. Defaults to tomorrow.'),
            parameter('timezone', 'IANA timezone. Defaults to Europe/Chisinau.'),
            parameter('limit', 'Maximum action item count.', { type: 'integer', minimum: 1, maximum: 100 }),
            ...sourceFilterParameters
          ],
          responses: {
            200: jsonResponse('Action items.')
          }
        }
      }
    }
  };
}
