# tg-mcp

Read-only Telegram digest MCP server for selected Telegram chats and channels.

## Current shape

- Node.js 22 ESM service.
- Express + MCP Streamable HTTP endpoint at `/mcp`.
- REST/OpenAPI fallback under `/tg-mcp/api` and `/tg-mcp/openapi.json`.
- MongoDB storage.
- GramJS-based Telegram sync CLI.
- Read-only MCP tools:
  - `list_sources`
  - `get_daily_digest`
  - `get_period_summary`
  - `search_telegram_messages`
  - `get_message_context`
  - `get_action_items`

## Local development

```bash
npm ci
cp .env.example .env
npm test
npm start
```

Health:

```bash
curl http://127.0.0.1:3010/health
```

REST/OpenAPI fallback:

```bash
curl http://127.0.0.1:3010/tg-mcp/openapi.json
curl http://127.0.0.1:3010/tg-mcp/api/digest/daily
curl "http://127.0.0.1:3010/tg-mcp/api/search?query=release"
```

If `APP_AUTH_TOKEN` is set, pass `Authorization: Bearer <token>` for REST and MCP calls.

## Telegram setup

Fill these values in `.env` or `/srv/tg-mcp/shared/.env`:

```text
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION_FILE=/srv/tg-mcp/shared/sessions/telegram.session
ALLOWED_SOURCE_IDS=
```

List available sources:

```bash
npm run cli -- list-sources
```

Save the source list into MongoDB, then enable selected chats/channels:

```bash
npm run cli -- refresh-sources
npm run cli -- db-sources --include-disabled
npm run cli -- enable-source <id> --tag work
npm run cli -- sync
```

Useful variants:

```bash
npm run cli -- disable-source <id>
npm run cli -- set-source-tags <id> --tag work --tag project-x
npm run cli -- sync --source-id <id> --limit 100
npm run cli -- backfill --days 7 --limit 1000
```

Alternatively, put selected source ids into `ALLOWED_SOURCE_IDS`; env selection overrides DB-enabled sources during sync.

The first Telegram command is interactive and writes the Telegram session file.

## Background sync

The HTTP service can run a safe background sync loop after the Telegram session file exists:

```text
TELEGRAM_SYNC_ENABLED=true
TELEGRAM_SYNC_INTERVAL_SECONDS=300
TELEGRAM_SYNC_ON_START=true
```

If credentials, session, or selected sources are missing, the worker logs a warning and waits for the next interval. It never prompts from the systemd service.

Normal sync is incremental: each source tracks `lastSyncedMessageId` and later runs request only newer Telegram messages. `backfill --days N` intentionally bypasses that cursor for historical imports.

## VPS quick deploy

The target server already has Apache, MongoDB, and bundled Node.js.

Expected layout:

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

Deploy code:

```bash
ops/deploy.sh
```

Install systemd service:

```bash
sudo ops/install-systemd-service.sh
```

Install Apache `/mcp` proxy:

```bash
sudo ops/install-apache-proxy.sh
```

That installer exposes:

```text
https://celticspear.com/mcp
https://celticspear.com/tg-mcp/openapi.json
https://celticspear.com/tg-mcp/api/...
```
