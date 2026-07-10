#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3010}"
OPENAPI_PATH="${OPENAPI_PATH:-/tg-mcp/openapi.json}"
REST_BASE_PATH="${REST_BASE_PATH:-/tg-mcp/api}"
MCP_PATH="${MCP_PATH:-/mcp}"
AUTH_TOKEN="${AUTH_TOKEN:-${APP_AUTH_TOKEN:-}}"

BASE_URL="${BASE_URL%/}"

AUTH_HEADERS=()
if [ -n "$AUTH_TOKEN" ]; then
  AUTH_HEADERS=(-H "Authorization: Bearer $AUTH_TOKEN")
fi

echo "== tg-mcp smoke =="
echo "base_url: $BASE_URL"

echo
echo "== health =="
curl -fsS "$BASE_URL/health"

echo
echo
echo "== openapi =="
curl -fsS "$BASE_URL$OPENAPI_PATH" >/dev/null
echo "ok $OPENAPI_PATH"

echo
echo "== rest sync status =="
curl -fsS "${AUTH_HEADERS[@]}" "$BASE_URL$REST_BASE_PATH/sync/status" >/dev/null
echo "ok $REST_BASE_PATH/sync/status"

echo
echo "== mcp initialize =="
curl -fsS "${AUTH_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"tg-mcp-smoke","version":"1.0.0"}}}' \
  "$BASE_URL$MCP_PATH" >/dev/null
echo "ok $MCP_PATH"

echo
echo "smoke ok"
