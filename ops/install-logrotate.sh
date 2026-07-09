#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/tg-mcp}"
LOGROTATE_D="${LOGROTATE_D:-/etc/logrotate.d}"
TARGET="$LOGROTATE_D/tg-mcp"
SOURCE="${SOURCE:-$APP_DIR/current/ops/tg-mcp.logrotate}"

if [ ! -f "$SOURCE" ]; then
  SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tg-mcp.logrotate"
fi

if [ ! -f "$SOURCE" ]; then
  echo "Cannot find tg-mcp.logrotate. Set SOURCE=/path/to/tg-mcp.logrotate." >&2
  exit 1
fi

install -m 0644 "$SOURCE" "$TARGET"

if command -v logrotate >/dev/null 2>&1; then
  logrotate -d "$TARGET" >/dev/null
fi

echo "Installed logrotate config: $TARGET"
