# tg-mcp quick plan

## Goal

Build a fast read-only ChatGPT MCP integration that gives ChatGPT controlled access to one Telegram user account and selected Telegram chats/channels.

This is a Telegram digest and search layer. It does not define a separate domain persona; the value is in controlled access to chosen Telegram sources and practical summaries of what happened there.

Primary prompt:

```text
Give me today's Telegram digest.
```

The assistant should help with:

- daily and weekly Telegram digests;
- summaries for selected chats/channels;
- important messages, decisions, questions, links, and action items;
- search across selected Telegram chats/channels;
- surrounding context for a specific message.

## Current VPS facts

Use the existing `celticspear.com` setup:

- Ubuntu 24.04.
- Apache on `80/443` with SSL already configured.
- MongoDB already running on `127.0.0.1:27017`.
- Node.js already bundled under the current backend shared folder.
- Existing deploy style is release-based:

```text
/srv/<app>/
  repo.git/
  releases/
  shared/
    .env
    logs/
    node/
  current -> releases/<release>
```

No Docker for the quick version.

## Chosen quick stack

- Runtime: Node.js 22.
- HTTP server: Express.
- Data store: MongoDB.
- Telegram ingestion: MTProto user client via GramJS.
- Optional Telegram slash interface: `grammy`, only for quick read-only checks against data already synced into MongoDB.
- MCP endpoint: HTTP MCP server exposed through Apache.
- Process manager: systemd.
- Reverse proxy: Apache.

Target public endpoint for the quick version:

```text
https://celticspear.com/mcp
```

Apache proxy:

```text
ProxyPass /mcp http://127.0.0.1:3010/mcp
ProxyPassReverse /mcp http://127.0.0.1:3010/mcp
```

If `/mcp` conflicts later, move to:

```text
https://celticspear.com/tg-mcp/mcp
```

or a subdomain:

```text
https://tg.celticspear.com/mcp
```

## Architecture

```text
Telegram user account
   -> selected chats/channels
   -> tg sync worker
   -> MongoDB
   -> Telegram digest service layer
   -> MCP tools at /mcp
   -> ChatGPT web
```

The first release is read-only. No sending Telegram messages from ChatGPT.

## Mongo collections

`tg_sources`

- `sourceId`
- `title`
- `username`
- `type`
- `enabled`
- `tags`
- `lastSyncedMessageId`
- `createdAt`
- `updatedAt`

`tg_messages`

- `sourceId`
- `messageId`
- `date`
- `senderId`
- `senderName`
- `text`
- `replyToMessageId`
- `views`
- `link`
- `entities`
- `raw`
- `createdAt`

Unique index:

```text
sourceId + messageId
```

Text index:

```text
text, senderName, source title/tags
```

`tg_digests`

- `periodStart`
- `periodEnd`
- `sourceIds`
- `timezone`
- `summary`
- `highlights`
- `questions`
- `decisions`
- `actionItems`
- `links`
- `generatedAt`

`sync_state`

- Telegram session metadata and sync cursors.
- Do not store secrets here; keep secrets in `/srv/tg-mcp/shared/.env`.

## MCP tools

Keep tools focused and read-only.

`list_sources`

- Use when the user asks what Telegram sources are available.
- Returns enabled sources, tags, and last sync time.

`get_sync_status`

- Use before summaries/search when the user needs to know whether Telegram data is fresh.
- Returns per-source freshness, stale/never-synced markers, and last sync metadata.

`get_daily_digest`

- Use when the user asks for today's/yesterday's Telegram summary.
- Inputs: `date`, `timezone`, optional `sourceIds`, optional `tags`.
- Output: summary, important threads, decisions, open questions, action items, links to source messages.

`get_period_summary`

- Use for weekly/monthly/custom period summaries.
- Inputs: `from`, `to`, `timezone`, optional filters.

`search_telegram_messages`

- Use when the user searches for a topic, person, project, link, bug, decision, file, or discussion.
- Inputs: query, date range, source filters, limit.
- Output: ranked message hits with short context and links.

`get_message_context`

- Use after search when the user wants the surrounding conversation.
- Inputs: `sourceId`, `messageId`, `before`, `after`.

`get_action_items`

- Use when the user asks what needs attention or follow-up.
- Inputs: date range and filters.
- Output: candidate threads with reason, last message, suggested next action.

## Assistant behavior

The assistant should:

- prioritize important messages, blockers, decisions, unanswered questions, links, and action items;
- summarize by practical importance, not by chronological chat log;
- include direct Telegram message links when available;
- avoid exposing raw private chat dumps unless the user asks for details;
- clearly say when data is missing or stale.

## Deployment layout

```text
/srv/tg-mcp/
  repo.git/
  releases/
  shared/
    .env
    logs/
    sessions/
    node/
  current -> releases/<release>
```

`tg-mcp.service`:

```ini
[Unit]
Description=Telegram Digest MCP
After=network-online.target mongod.service
Wants=network-online.target
Requires=mongod.service

[Service]
Type=simple
User=s4relok
Group=www-data
WorkingDirectory=/srv/tg-mcp/current
EnvironmentFile=/srv/tg-mcp/shared/.env
ExecStart=/srv/tg-mcp/shared/node/bin/node src/server.js
Restart=always
RestartSec=5
StandardOutput=append:/srv/tg-mcp/shared/logs/app.log
StandardError=append:/srv/tg-mcp/shared/logs/app.log

[Install]
WantedBy=multi-user.target
```

## Environment

```text
NODE_ENV=production
PORT=3010
PUBLIC_BASE_URL=https://celticspear.com
MCP_PATH=/mcp

MONGO_URL=mongodb://127.0.0.1:27017
MONGO_DB=tg_mcp

TELEGRAM_MODE=user
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION_FILE=/srv/tg-mcp/shared/sessions/telegram.session

TELEGRAM_BOT_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_ALLOWED_CHAT_IDS=
TELEGRAM_BOT_TIMEZONE=Europe/Chisinau

ALLOWED_SOURCE_IDS=
APP_AUTH_TOKEN=
ALLOW_UNAUTHENTICATED=false
```

For quick personal use, `APP_AUTH_TOKEN` can protect the MCP endpoint while developing. For a publishable ChatGPT App, replace this with the proper OAuth flow.

## Fast implementation phases

### Phase 1: local skeleton

- Create Node project.
- Add Express server with `/health`.
- Add MCP endpoint at `/mcp`.
- Add Mongo connection.
- Add config/env loader.

Acceptance:

- local server starts;
- `/health` returns ok;
- MCP tool list works.

### Phase 2: Telegram ingestion

- Add `setup-env` for safe env bootstrapping and auth token generation.
- Add GramJS login and session file support.
- Add explicit `npm run cli -- login` setup command.
- Add `list_sources`.
- Add whitelist config.
- Add query-based source selection commands for setup.
- Sync last N messages per enabled source.
- Store messages idempotently in Mongo.

Acceptance:

- selected Telegram sources are visible;
- messages appear in Mongo;
- sync can restart without duplicates.

### Phase 3: Telegram digest tools

- Implement `search_telegram_messages`.
- Implement `get_daily_digest`.
- Implement `get_message_context`.
- Add Mongo indexes.

Acceptance:

- ChatGPT can ask for today's digest;
- search returns useful hits with links.
- ChatGPT can detect and report missing or stale Telegram sync data.

### Phase 4: VPS deploy

- Create `/srv/tg-mcp` release layout.
- Install service.
- Add Apache proxy for `/mcp`.
- Verify HTTPS endpoint.

Acceptance:

- `systemctl status tg-mcp` is healthy;
- `https://celticspear.com/mcp` is reachable by ChatGPT developer mode.

### Phase 5: polish

- Add digest cache with sync-state invalidation and manual `refresh`.
- Add `get_action_items`.
- Add basic admin CLI commands:
  - `sync`
  - `list-sources`
  - `backfill --days N`
- Add protected admin endpoints for source management and non-interactive sync.
- Add optional Telegram slash bot commands:
  - `/digest_today`
  - `/digest_week`
  - `/search <query>`
  - `/actions`
- Add log rotation for `/srv/tg-mcp/shared/logs/*.log`.

## Not in the quick version

- Docker.
- PostgreSQL.
- Vector database.
- Sending Telegram messages.
- Public marketplace submission.
- Complex custom UI inside ChatGPT.

## Optional Telegram slash commands

The quick version can run a Telegram bot for quick read-only checks against the same selected MongoDB data:

```text
/digest_today
/digest_week
/search <query>
/actions
/sources
```

This is separate from the ChatGPT MCP endpoint `/mcp`.
