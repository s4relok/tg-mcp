# tg-mcp

Read-only Telegram digest MCP server for selected Telegram chats and channels.

## Current shape

- Node.js 22 ESM service.
- Express + MCP Streamable HTTP endpoint at `/mcp`.
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

Then put selected source ids into `ALLOWED_SOURCE_IDS` and sync:

```bash
npm run cli -- sync
```

Useful variants:

```bash
npm run cli -- db-sources --include-disabled
npm run cli -- sync --source-id <id> --limit 100
npm run cli -- backfill --days 7 --limit 1000
```

The first run is interactive and writes the Telegram session file.

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
