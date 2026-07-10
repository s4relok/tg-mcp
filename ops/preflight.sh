#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/tg-mcp}"
ENV_FILE="${ENV_FILE:-$APP_DIR/shared/.env}"
NODE_DIR="${NODE_DIR:-$APP_DIR/shared/node}"
WORK_DIR="${WORK_DIR:-$(pwd)}"
RUN_TESTS="${RUN_TESTS:-true}"
CHECK_TELEGRAM="${CHECK_TELEGRAM:-false}"

if [ -x "$NODE_DIR/bin/node" ]; then
  export PATH="$NODE_DIR/bin:$PATH"
fi

cd "$WORK_DIR"

echo "== tg-mcp preflight =="
echo "work_dir: $WORK_DIR"
echo "env_file: $ENV_FILE"

echo
echo "== runtime =="
node --version
npm --version

if ! node -e "const major = Number(process.versions.node.split('.')[0]); process.exit(major >= 22 ? 0 : 1)"; then
  echo "Node.js 22+ is required." >&2
  exit 1
fi

echo
echo "== source =="
git rev-parse --short HEAD
git status --short --branch

if [ "$RUN_TESTS" = "true" ]; then
  echo
  echo "== tests =="
  npm test
fi

echo
echo "== readiness =="
DOCTOR_ARGS=(doctor --env-path "$ENV_FILE")
if [ "$CHECK_TELEGRAM" = "true" ]; then
  DOCTOR_ARGS+=(--telegram)
fi

npm run cli -- "${DOCTOR_ARGS[@]}"
