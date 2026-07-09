#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/tg-mcp}"
REPO_URL="${REPO_URL:-git@github.com:s4relok/tg-mcp.git}"
REF="${1:-main}"
NODE_SOURCE="${NODE_SOURCE:-/srv/celticspear.com/backend/shared/node}"

mkdir -p "$APP_DIR/releases" "$APP_DIR/shared/logs" "$APP_DIR/shared/sessions"

if [ ! -e "$APP_DIR/shared/node" ] && [ -d "$NODE_SOURCE" ]; then
  ln -s "$NODE_SOURCE" "$APP_DIR/shared/node"
fi

if [ ! -d "$APP_DIR/repo.git" ]; then
  git clone --bare "$REPO_URL" "$APP_DIR/repo.git"
fi

git --git-dir="$APP_DIR/repo.git" fetch origin "$REF"
COMMIT="$(git --git-dir="$APP_DIR/repo.git" rev-parse FETCH_HEAD)"
SHORT_COMMIT="$(git --git-dir="$APP_DIR/repo.git" rev-parse --short FETCH_HEAD)"
RELEASE="$APP_DIR/releases/$(date -u +%Y%m%d-%H%M%S)-$SHORT_COMMIT"

mkdir -p "$RELEASE"
git --git-dir="$APP_DIR/repo.git" --work-tree="$RELEASE" checkout -f "$COMMIT"

export PATH="$APP_DIR/shared/node/bin:$PATH"
cd "$RELEASE"
npm ci --omit=dev
npm test

ln -sfn "$RELEASE" "$APP_DIR/current"

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files tg-mcp.service >/dev/null 2>&1; then
  systemctl restart tg-mcp.service
fi

echo "deployed $SHORT_COMMIT to $RELEASE"
