#!/usr/bin/env bash
set -euo pipefail

SITE_CONF="${SITE_CONF:-/etc/apache2/sites-available/celticspear.com.conf}"
BACKUP="$SITE_CONF.before-tg-mcp-$(date -u +%Y%m%d-%H%M%S)"

INSERT_LINES=()
if ! grep -q 'ProxyPass /mcp ' "$SITE_CONF"; then
  INSERT_LINES+=(
    "    ProxyPass /mcp http://127.0.0.1:3010/mcp"
    "    ProxyPassReverse /mcp http://127.0.0.1:3010/mcp"
  )
fi
if ! grep -q 'ProxyPass /tg-mcp/ ' "$SITE_CONF"; then
  INSERT_LINES+=(
    "    ProxyPass /tg-mcp/ http://127.0.0.1:3010/tg-mcp/"
    "    ProxyPassReverse /tg-mcp/ http://127.0.0.1:3010/tg-mcp/"
  )
fi

if [ "${#INSERT_LINES[@]}" -eq 0 ]; then
  echo "Apache tg-mcp proxies already exist in $SITE_CONF"
  exit 0
fi

cp "$SITE_CONF" "$BACKUP"

printf -v INSERT '%s\n' "${INSERT_LINES[@]}"
INSERT="$INSERT" perl -0pi -e 's#(\n\s*ProxyPreserveHost On\n)#$1$ENV{INSERT}#' "$SITE_CONF"

if ! apache2ctl configtest; then
  cp "$BACKUP" "$SITE_CONF"
  apache2ctl configtest
  echo "Apache config failed; restored $BACKUP" >&2
  exit 1
fi

systemctl reload apache2.service
echo "Installed Apache tg-mcp proxies. Backup: $BACKUP"
