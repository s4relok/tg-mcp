#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/tg-mcp}"

mkdir -p "$APP_DIR/shared/logs" "$APP_DIR/shared/sessions"
chown -R s4relok:www-data "$APP_DIR/shared/logs" "$APP_DIR/shared/sessions"
chmod 2775 "$APP_DIR/shared/logs" "$APP_DIR/shared/sessions"

install -m 0644 "$APP_DIR/current/ops/tg-mcp.service" /etc/systemd/system/tg-mcp.service
systemctl daemon-reload
systemctl enable --now tg-mcp.service
systemctl status tg-mcp.service --no-pager
