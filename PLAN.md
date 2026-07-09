# tg-mcp quick plan

## Goal

Build a fast read-only ChatGPT MCP integration for a "Sales Expert" assistant that can use Telegram context.

Primary prompt:

```text
Give me today's sales summary from Telegram.
```

The assistant should help with:

- daily and weekly sales digests;
- lead/customer mentions;
- objections and follow-up opportunities;
- search across selected Telegram channels/chats;
- channel or account summaries.

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
- Telegram ingestion:
  - preferred: MTProto user client via GramJS, if personal account/channel access is needed;
  - fallback: Telegram Bot API via `grammy`, if bot-accessible chats are enough.
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
Telegram account / bot
   -> tg sync worker
   -> MongoDB
   -> Sales Expert service layer
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

`sales_digests`

- `periodStart`
- `periodEnd`
- `sourceIds`
- `timezone`
- `summary`
- `highlights`
- `leads`
- `objections`
- `followUps`
- `generatedAt`

`sync_state`

- Telegram session metadata and sync cursors.
- Do not store secrets here; keep secrets in `/srv/tg-mcp/shared/.env`.

## MCP tools

Keep tools focused and read-only.

`list_sources`

- Use when the user asks what Telegram sources are available.
- Returns enabled sources, tags, and last sync time.

`get_daily_sales_digest`

- Use when the user asks for today's/yesterday's sales summary.
- Inputs: `date`, `timezone`, optional `sourceIds`, optional `tags`.
- Output: summary, important threads, leads, objections, follow-ups, links to source messages.

`get_period_sales_summary`

- Use for weekly/monthly/custom period summaries.
- Inputs: `from`, `to`, `timezone`, optional filters.

`search_telegram_sales_messages`

- Use when the user searches for a customer, product, objection, competitor, price, bug, or deal.
- Inputs: query, date range, source filters, limit.
- Output: ranked message hits with short context and links.

`get_message_context`

- Use after search when the user wants the surrounding conversation.
- Inputs: `sourceId`, `messageId`, `before`, `after`.

`get_follow_up_candidates`

- Use when the user asks what needs follow-up.
- Inputs: date range and filters.
- Output: candidate threads with reason, last message, suggested next action.

## Sales Expert behavior

The assistant should:

- prioritize opportunities, blockers, objections, customer intent, pricing questions, and unanswered asks;
- summarize by business impact, not by chronological chat log;
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
Description=Telegram Sales MCP
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

ALLOWED_SOURCE_IDS=
APP_AUTH_TOKEN=
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

- Add GramJS login and session file support.
- Add `list_sources`.
- Add whitelist config.
- Sync last N messages per enabled source.
- Store messages idempotently in Mongo.

Acceptance:

- selected Telegram sources are visible;
- messages appear in Mongo;
- sync can restart without duplicates.

### Phase 3: Sales tools

- Implement `search_telegram_sales_messages`.
- Implement `get_daily_sales_digest`.
- Implement `get_message_context`.
- Add Mongo indexes.

Acceptance:

- ChatGPT can ask for today's digest;
- search returns useful hits with links.

### Phase 4: VPS deploy

- Create `/srv/tg-mcp` release layout.
- Install service.
- Add Apache proxy for `/mcp`.
- Verify HTTPS endpoint.

Acceptance:

- `systemctl status tg-mcp` is healthy;
- `https://celticspear.com/mcp` is reachable by ChatGPT developer mode.

### Phase 5: polish

- Add digest cache.
- Add `get_follow_up_candidates`.
- Add basic admin CLI commands:
  - `sync`
  - `list-sources`
  - `backfill --days N`
- Add log rotation.

## Not in the quick version

- Docker.
- PostgreSQL.
- Vector database.
- Sending Telegram messages.
- Public marketplace submission.
- Complex custom UI inside ChatGPT.

## Optional later: Telegram slash commands

If useful, add a Telegram bot for quick checks:

```text
/sales_today
/sales_week
/search <query>
/followups
```

This is separate from the ChatGPT MCP endpoint `/mcp`.
