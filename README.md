# tg-mcp

[![CI](https://github.com/s4relok/tg-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/s4relok/tg-mcp/actions/workflows/ci.yml)

Read-only Telegram digest MCP server that logs into a Telegram user account and works only with selected Telegram chats and channels.

## Current shape

- Node.js 22 ESM service.
- Express + MCP Streamable HTTP endpoint at `/mcp`.
- REST/OpenAPI fallback under `/tg-mcp/api` and `/tg-mcp/openapi.json`.
- MongoDB storage.
- GramJS-based Telegram user account sync CLI.
- Optional read-only Telegram slash bot.
- MCP prompts:
  - `daily_telegram_digest`
  - `search_telegram`
- Read-only MCP tools:
  - `list_sources`
  - `get_sync_status`
  - `get_daily_digest`
  - `get_period_summary`
  - `search_telegram_messages`
  - `get_message_context`
  - `get_action_items`
  - `get_source_summary`

## Local development

```bash
npm ci
npm run cli -- setup-env
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
curl "http://127.0.0.1:3010/tg-mcp/api/sync/status"
curl "http://127.0.0.1:3010/tg-mcp/api/digest/daily?timelineLimit=80"
curl "http://127.0.0.1:3010/tg-mcp/api/sources/<sourceId>/summary?date=2026-07-09"
curl "http://127.0.0.1:3010/tg-mcp/api/digest/daily?sourceQuery=project"
curl "http://127.0.0.1:3010/tg-mcp/api/digest/daily?refresh=true"
curl "http://127.0.0.1:3010/tg-mcp/api/search?query=release"
```

If `APP_AUTH_TOKEN` is set, pass `Authorization: Bearer <token>` for REST and MCP calls.

When `NODE_ENV=production`, the HTTP service refuses to start without `APP_AUTH_TOKEN` unless `ALLOW_UNAUTHENTICATED=true` is set explicitly. Keep that override only for private tests.

## Telegram setup

Fill these values in `.env` or `/srv/tg-mcp/shared/.env`:

```text
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION_FILE=/srv/tg-mcp/shared/sessions/telegram.session
ALLOWED_SOURCE_IDS=
```

Create or update the env file:

```bash
npm run cli -- setup-env --set TELEGRAM_API_ID=<api_id> --set TELEGRAM_API_HASH=<api_hash>
```

For the VPS layout:

```bash
export TELEGRAM_API_ID=<api_id>
export TELEGRAM_API_HASH=<api_hash>
npm run cli -- setup-env --production --env-path /srv/tg-mcp/shared/.env --from-env TELEGRAM_API_ID --from-env TELEGRAM_API_HASH
```

Existing secrets are preserved unless you pass a new value with `--set` or `--from-env`. The command writes mode `0600`, creates a backup before overwriting an existing file, and generates `APP_AUTH_TOKEN` when it is missing.

List available sources:

```bash
npm run cli -- login
npm run cli -- doctor --telegram
npm run cli -- list-sources
```

Save the source list into MongoDB, then enable selected chats/channels:

```bash
npm run cli -- refresh-sources
npm run cli -- find-sources project
npm run cli -- select-source "Project Alpha" --tag work
npm run cli -- sync
```

Useful variants:

```bash
npm run cli -- disable-source <id>
npm run cli -- set-source-tags <id> --tag work --tag project-x
npm run cli -- enable-source <id> --tag work
npm run cli -- db-sources --include-disabled
npm run cli -- sync --source-id <id> --limit 100
npm run cli -- backfill --days 7 --limit 1000
```

Alternatively, put selected source ids into `ALLOWED_SOURCE_IDS`; env selection overrides DB-enabled sources during sync.

`login` is interactive and writes the Telegram session file. Later commands reuse that session and should not prompt unless Telegram requires reauthorization.

Check readiness:

```bash
npm run cli -- doctor
npm run cli -- doctor --telegram
npm run cli -- doctor --env-path /srv/tg-mcp/shared/.env
```

`doctor` returns machine-readable checks plus `nextSteps` with the next safe commands for the current setup state. `doctor --telegram` also performs a non-interactive authorization check with the existing session file.

Every CLI command that reads runtime config accepts `--env-path PATH`, and the service also honors `TG_MCP_ENV_FILE`. This is useful on the VPS because production secrets live in `/srv/tg-mcp/shared/.env`, outside the release checkout.

## Admin operations

Authenticated admin endpoints are available for operations that should not be exposed as MCP tools:

```bash
curl -X POST http://127.0.0.1:3010/admin/sources/refresh \
  -H "Authorization: Bearer <APP_AUTH_TOKEN>"

curl -X POST http://127.0.0.1:3010/admin/sources/select \
  -H "Authorization: Bearer <APP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"query":"Project Alpha","tags":["work"]}'

curl -X POST http://127.0.0.1:3010/admin/sync \
  -H "Authorization: Bearer <APP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"sourceIds":["<sourceId>"],"limit":100}'
```

Use `{"backfillDays":7}` with `/admin/sync` to bypass the incremental cursor for a historical import. Source management endpoints also support `/admin/sources/<sourceId>/enable`, `/admin/sources/<sourceId>/disable`, and `/admin/sources/<sourceId>/tags`. Endpoints that talk to Telegram use the existing session file and never prompt.

## Background sync

The HTTP service can run a safe background sync loop after the Telegram session file exists:

```text
TELEGRAM_SYNC_ENABLED=true
TELEGRAM_SYNC_INTERVAL_SECONDS=300
TELEGRAM_SYNC_ON_START=true
```

If credentials, session, or selected sources are missing, the worker logs a warning and waits for the next interval. It never prompts from the systemd service.

Normal sync is incremental: each source tracks `lastSyncedMessageId` and later runs request only newer Telegram messages. `backfill --days N` intentionally bypasses that cursor for historical imports.

Check data freshness:

```bash
curl "http://127.0.0.1:3010/tg-mcp/api/sync/status?staleAfterHours=24"
```

The MCP tool `get_sync_status` exposes the same source freshness state to ChatGPT so it can say when data is missing or stale before summarizing.

## Digest cache

Daily, period, and source summaries are cached in `tg_digests`. The cache key includes the period, timezone, source filters, timeline options, and selected source sync state, so a later Telegram sync naturally invalidates stale summaries.

Use `refresh=true` in REST calls, or `refresh: true` in MCP tool arguments, to force recomputation from stored messages.

## Optional Telegram slash bot

The HTTP service can also run a small read-only Telegram bot for quick checks against the same selected data:

```text
TELEGRAM_BOT_ENABLED=true
TELEGRAM_BOT_TOKEN=<bot token from BotFather>
TELEGRAM_BOT_ALLOWED_CHAT_IDS=<your chat id or comma-separated ids>
TELEGRAM_BOT_TIMEZONE=Europe/Chisinau
```

Supported commands:

```text
/digest_today [source]
/digest_week [source]
/search <query>
/actions [source]
/sources [query]
```

`TELEGRAM_BOT_ALLOWED_CHAT_IDS` is optional, but recommended. The bot never sends Telegram messages on behalf of the synced user account; it only replies with digests/search results from MongoDB.

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

Run a VPS preflight from a checkout or release directory:

```bash
ENV_FILE=/srv/tg-mcp/shared/.env ops/preflight.sh
CHECK_TELEGRAM=true ENV_FILE=/srv/tg-mcp/shared/.env ops/preflight.sh
```

The preflight checks Node.js, git state, tests, and `doctor` against the selected env file. `CHECK_TELEGRAM=true` additionally verifies the existing Telegram session without prompting.

Install systemd service:

```bash
sudo ops/install-systemd-service.sh
```

Install Apache `/mcp` proxy:

```bash
sudo ops/install-apache-proxy.sh
```

Install log rotation for `/srv/tg-mcp/shared/logs/*.log`:

```bash
sudo ops/install-logrotate.sh
```

That installer exposes:

```text
https://celticspear.com/mcp
https://celticspear.com/tg-mcp/openapi.json
https://celticspear.com/tg-mcp/api/...
```
