# tg-mcp

[![CI](https://github.com/s4relok/tg-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/s4relok/tg-mcp/actions/workflows/ci.yml)

Telegram digest MCP server that logs into a Telegram user account and works only with selected Telegram chats and channels. Read access is the default; source management is an explicit authenticated capability.

## Current shape

- Node.js 22 ESM service.
- Express + MCP Streamable HTTP endpoint at `/mcp`.
- Optional OAuth 2.1 protected MCP endpoint at `/tg-mcp/oauth-mcp`.
- REST/OpenAPI fallback under `/tg-mcp/api` and `/tg-mcp/openapi.json`.
- MongoDB storage.
- GramJS-based Telegram user account sync CLI.
- Optional OpenAI Audio Transcriptions pipeline for Telegram voice/audio messages.
- Optional read-only Telegram slash bot.
- MCP prompts:
  - `daily_telegram_digest`
  - `search_telegram`
- Read-only MCP tools:
  - `list_sources`
  - `get_sync_status`
  - `get_audio_transcription_status`
  - `get_daily_digest`
  - `get_period_summary`
  - `search_telegram_messages`
  - `get_message_context`
  - `get_action_items`
  - `get_source_summary`
- Optional authenticated owner MCP tools:
  - `enable_source`
  - `disable_source`
  - `set_source_tags`
  - `sync_source`
  - `get_source_settings`
  - `update_source_settings`

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
curl "http://127.0.0.1:3010/tg-mcp/api/transcriptions/status"
curl "http://127.0.0.1:3010/tg-mcp/api/digest/daily?timelineLimit=80"
curl "http://127.0.0.1:3010/tg-mcp/api/sources/<sourceId>/summary?date=2026-07-09"
curl "http://127.0.0.1:3010/tg-mcp/api/digest/daily?sourceQuery=project"
curl "http://127.0.0.1:3010/tg-mcp/api/digest/daily?refresh=true"
curl "http://127.0.0.1:3010/tg-mcp/api/search?query=release"
```

If `APP_AUTH_TOKEN` is set, pass `Authorization: Bearer <token>` for REST and MCP calls.

When `NODE_ENV=production`, the HTTP service refuses to start without `APP_AUTH_TOKEN` unless `ALLOW_UNAUTHENTICATED=true` is set explicitly. Keep that override only for private tests.

## ChatGPT Web developer-mode test

ChatGPT Web developer-mode apps do not accept a custom static bearer token for MCP. Authenticated MCP apps should implement OAuth 2.1. For a private read-only test, keep the main `/mcp` endpoint protected and expose a second no-auth endpoint with a long random path:

```text
CHATGPT_MCP_PATH=/tg-mcp/chatgpt-mcp-<long-random-slug>
```

Then paste this URL into ChatGPT Web as the developer-mode MCP server URL:

```text
https://celticspear.com/tg-mcp/chatgpt-mcp-<long-random-slug>
```

Do not publish that URL. Anyone who knows it can call the read-only MCP tools for the selected Telegram sources. The no-auth path never exposes disabled source metadata or source-management tools, even when owner management is enabled elsewhere. For a shared or published app, use the OAuth endpoint below.

## OAuth 2.1 MCP endpoint

`tg-mcp` can act as an OAuth protected resource server for ChatGPT. It deliberately does not implement login, consent, token issuance, client registration, or refresh tokens: use an established external identity provider that supports authorization code + PKCE and publishes OAuth/OIDC discovery metadata.

Configure the resource server:

```text
OAUTH_ENABLED=true
OAUTH_MCP_PATH=/tg-mcp/oauth-mcp
OAUTH_RESOURCE=https://celticspear.com/tg-mcp/oauth-mcp
OAUTH_ISSUER=https://<your-idp-issuer>
OAUTH_JWKS_URL=https://<your-idp-issuer>/<jwks-path>
OAUTH_JWT_ALGORITHMS=RS256,ES256
OAUTH_ALLOWED_SUBJECTS=<your-exact-idp-sub>
OAUTH_RESOURCE_DOCUMENTATION=https://<your-docs-url>
```

The IdP must echo the OAuth `resource` parameter and issue an expiring JWT access token with an audience exactly equal to `OAUTH_RESOURCE`. Tokens must contain `sub`, `scope` or `scp`, and preferably `client_id` or `azp`. Configure ChatGPT's callback URL shown in the app/connector management UI and let the IdP expose its authorization/token endpoints through discovery.

Available scopes:

- `telegram:read`: enabled-source lists, digests, search, summaries, and status.
- `telegram:sources:read`: disabled-source catalog and source settings.
- `telegram:sources:manage`: enable/disable, tags, and settings mutations.
- `telegram:sync:run`: exact bounded manual sync.

The OAuth transport always requires `telegram:read`. Each privileged tool checks its additional scopes against the current request token, including after a session has been initialized. Missing scopes return an MCP `mcp/www_authenticate` challenge so ChatGPT can request authorization again.

Discovery metadata is published at both:

```text
https://celticspear.com/.well-known/oauth-protected-resource
https://celticspear.com/.well-known/oauth-protected-resource/tg-mcp/oauth-mcp
```

`MCP_SOURCE_MANAGEMENT_ENABLED=true` is still required before privileged source tools are registered. Keep `APP_AUTH_TOKEN` for admin, REST, CLI setup, and the legacy `/mcp` endpoint; OAuth protects only `OAUTH_MCP_PATH`. See the implementation and IdP rollout checklist in [docs/oauth-scopes-plan.md](docs/oauth-scopes-plan.md).

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

Existing secrets and safety allowlists (`ALLOWED_SOURCE_IDS`, `OAUTH_ALLOWED_SUBJECTS`) are preserved unless you pass a new value with `--set` or `--from-env`. The command writes mode `0600`, creates a backup before overwriting an existing file, and generates `APP_AUTH_TOKEN` when it is missing.

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
npm run cli -- get-source-settings <id>
npm run cli -- update-source-settings <id> --sync-interval-seconds 900 --history-depth-days 30 --priority 80
npm run cli -- update-source-settings <id> --include-media false --include-replies true --include-forwarded-posts false
npm run cli -- update-source-settings <id> --priority inherit
npm run cli -- db-sources --include-disabled
npm run cli -- sync --source-id <id> --limit 100
npm run cli -- backfill --days 7 --limit 1000
npm run cli -- transcription-status --source-id <id>
npm run cli -- transcribe-audio --source-id <id> --limit 1
npm run cli -- retry-failed-transcriptions --source-id <id> --limit 10
```

`tg_sources.enabled` is the operational source of truth. If `ALLOWED_SOURCE_IDS` is set, it is an additional hard server ceiling: a DB-enabled source outside that list cannot be synchronized, including through CLI, admin, or MCP manual sync. Run `refresh-sources` before enabling a newly discovered source.

Tags are normalized to lowercase. `set-source-tags` replaces tags by default; use `--mode add` or `--mode remove` for incremental changes.

Disabling a source stops future sync and excludes it from normal search/digests, but it does not delete already stored messages. To delete them, first disable the source and then run the CLI-only destructive operation:

```bash
npm run cli -- purge-source-data <id> --force
```

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

Use `{"backfillDays":7}` with `/admin/sync` to bypass the incremental cursor for a historical import. Source management endpoints also support `/admin/sources/<sourceId>/enable`, `/admin/sources/<sourceId>/disable`, `/admin/sources/<sourceId>/tags`, and `GET/PATCH /admin/sources/<sourceId>/settings`. Endpoints that talk to Telegram use the existing session file and never prompt.

Example settings patch with optimistic concurrency:

```bash
curl -X PATCH http://127.0.0.1:3010/admin/sources/<sourceId>/settings \
  -H "Authorization: Bearer <APP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"settings":{"syncIntervalSeconds":900,"priority":80},"expectedVersion":2}'
```

All successful source mutations are appended to `tg_source_audit` with actor, action, before/after state, and timestamp.

## Background sync

The HTTP service can run a safe background sync loop after the Telegram session file exists:

```text
TELEGRAM_SYNC_ENABLED=true
TELEGRAM_SYNC_INTERVAL_SECONDS=300
TELEGRAM_SYNC_ON_START=true
SOURCE_DEFAULT_SYNC_INTERVAL_SECONDS=300
SOURCE_DEFAULT_HISTORY_DEPTH_DAYS=30
SOURCE_SCHEDULER_POLL_INTERVAL_SECONDS=30
```

If credentials, session, or selected sources are missing, the worker logs a warning and waits for the next interval. It never prompts from the systemd service.

The scheduler polls for due sources, orders them by `nextSyncAt` and per-source priority, and uses a lease so background, admin, CLI, and MCP sync cannot overlap for the same source. `TELEGRAM_SYNC_INTERVAL_SECONDS` remains a compatibility fallback for `SOURCE_DEFAULT_SYNC_INTERVAL_SECONDS`.

Normal sync is incremental: each source tracks `lastSyncedMessageId` and later runs request only newer Telegram messages. `backfill --days N` intentionally bypasses that cursor for historical imports, but is clamped to the source's `historyDepthDays` setting.

Per-source settings:

- `syncIntervalSeconds`: `60..604800`, or `null`/CLI `inherit` for the server default.
- `historyDepthDays`: `1..3650`, or inherit. This limits import depth and is not retention.
- `includeMedia`: keeps supported media metadata and permits supported audio transcription jobs; text captions remain searchable when media metadata is disabled.
- `includeReplies`: imports or skips reply messages.
- `includeForwardedPosts`: imports or skips forwarded messages.
- `priority`: `0..100`; higher values run first when multiple sources are due.

To expose owner write tools on the bearer-protected MCP endpoint, explicitly enable:

```text
MCP_SOURCE_MANAGEMENT_ENABLED=true
```

This flag has no effect on the no-auth `CHATGPT_MCP_PATH`; that endpoint remains read-only. On the OAuth endpoint, the same tools additionally require `telegram:sources:read` plus `telegram:sources:manage` (or `telegram:sync:run` for manual sync).

Check data freshness:

```bash
curl "http://127.0.0.1:3010/tg-mcp/api/sync/status?staleAfterHours=24"
```

The MCP tool `get_sync_status` exposes the same source freshness state to ChatGPT so it can say when data is missing or stale before summarizing.

## Audio transcription

Telegram voice notes and audio files are synced as messages even when they do not have a text caption. The sync stores audio metadata in MongoDB and queues them with `transcription.status=pending`. Once transcribed, the transcript is stored as `transcriptText` on the same `tg_messages` document, included in Mongo text search, message context, daily digests, and action detection.

Enable the OpenAI Audio Transcriptions worker:

```text
OPENAI_API_KEY=<openai_api_key>
OPENAI_TRANSCRIPTION_ENABLED=true
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
AUDIO_TRANSCRIPTION_SOURCE_IDS=<saved_messages_source_id>
AUDIO_TRANSCRIPTION_INTERVAL_SECONDS=3600
AUDIO_TRANSCRIPTION_BATCH_SIZE=1
AUDIO_TRANSCRIPTION_WORK_DIR=/srv/tg-mcp/shared/audio-work
```

The background worker only claims jobs from explicitly configured transcription sources: `AUDIO_TRANSCRIPTION_SOURCE_IDS` or `AUDIO_TRANSCRIPTION_SOURCE_TAGS`. If neither is set, it will not process pending audio from arbitrary enabled Telegram chats. When background sync stores at least one audio/voice message, the service immediately runs one bounded transcription pass; `AUDIO_TRANSCRIPTION_INTERVAL_SECONDS` remains a safety polling interval. Keep `AUDIO_TRANSCRIPTION_BATCH_SIZE=1` to cap each pass to one OpenAI request.

`gpt-4o-mini-transcribe` is the default for clean personal recordings. Use `gpt-4o-transcribe` when recordings are noisy, terminology-heavy, or require the highest available transcription quality.

The worker downloads Telegram media into the work directory, submits it to the OpenAI Audio Transcriptions API, stores only the transcript/metadata by default, and removes the temporary audio file. Completed items have `transcriptText` plus `transcription.status=done`, so later runs do not claim the same file again. Files larger than `AUDIO_TRANSCRIPTION_MAX_FILE_BYTES` are split with `ffmpeg` when `AUDIO_TRANSCRIPTION_SPLIT_LARGE_FILES=true`.

Manual operations:

```bash
npm run cli -- transcription-status
npm run cli -- transcribe-audio --limit 1
npm run cli -- transcribe-audio --source-id <saved_messages_source_id> --limit 1
npm run cli -- retry-failed-transcriptions --limit 10
```

Authenticated admin endpoints:

```bash
curl http://127.0.0.1:3010/admin/transcriptions/status \
  -H "Authorization: Bearer <APP_AUTH_TOKEN>"

curl -X POST http://127.0.0.1:3010/admin/transcriptions/run \
  -H "Authorization: Bearer <APP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"sourceIds":["<saved_messages_source_id>"],"limit":1}'

curl -X POST http://127.0.0.1:3010/admin/transcriptions/retry-failed \
  -H "Authorization: Bearer <APP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"limit":10}'
```

The read-only REST endpoint `/tg-mcp/api/transcriptions/status` and MCP tool `get_audio_transcription_status` expose counts for selected sources. Search and digest tools automatically use completed transcripts.

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

Run a smoke test after the HTTP service is running:

```bash
AUTH_TOKEN=<APP_AUTH_TOKEN> BASE_URL=http://127.0.0.1:3010 ops/smoke.sh
AUTH_TOKEN=<APP_AUTH_TOKEN> BASE_URL=https://celticspear.com ops/smoke.sh
```

The smoke test checks `/health`, OpenAPI, REST sync status, and an MCP initialize request.

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
https://celticspear.com/tg-mcp/oauth-mcp
https://celticspear.com/.well-known/oauth-protected-resource
https://celticspear.com/tg-mcp/openapi.json
https://celticspear.com/tg-mcp/api/...
```
