#!/usr/bin/env bash
set -euo pipefail

SITE_CONF="${SITE_CONF:-/etc/apache2/sites-available/celticspear.com.conf}"
BACKUP="$SITE_CONF.before-tg-mcp-$(date -u +%Y%m%d-%H%M%S)"

if grep -q 'ProxyPass /mcp ' "$SITE_CONF"; then
  echo "Apache /mcp proxy already exists in $SITE_CONF"
  exit 0
fi

cp "$SITE_CONF" "$BACKUP"

perl -0pi -e 's#(\n\s*ProxyPreserveHost On\n)#$1    ProxyPass /mcp http://127.0.0.1:3010/mcp\n    ProxyPassReverse /mcp http://127.0.0.1:3010/mcp\n#' "$SITE_CONF"

if ! apache2ctl configtest; then
  cp "$BACKUP" "$SITE_CONF"
  apache2ctl configtest
  echo "Apache config failed; restored $BACKUP" >&2
  exit 1
fi

systemctl reload apache2.service
echo "Installed Apache /mcp proxy. Backup: $BACKUP"
