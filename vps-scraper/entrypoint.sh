#!/usr/bin/env bash
set -euo pipefail

# Persist DATABASE_URL + DATA_DIR + proxy env for cron jobs (cron strips env)
{
  echo "DATABASE_URL=${DATABASE_URL}"
  echo "DATA_DIR=${DATA_DIR}"
  echo "TZ=${TZ:-UTC}"
  echo "BRD_USER=${BRD_USER:-}"
  echo "BRD_PASS=${BRD_PASS:-}"
  echo "BRD_SERVER=${BRD_SERVER:-}"
  echo "PROXY_SERVER=${PROXY_SERVER:-}"
  echo "PROXY_USERNAME=${PROXY_USERNAME:-}"
  echo "PROXY_PASSWORD=${PROXY_PASSWORD:-}"
  echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
} > /etc/environment

# Kick off an immediate scrape in the background so we get data on first boot
# without waiting until 08:00 UTC.
( sleep 30 && cd /app && node scraper.mjs >> /var/log/cron.log 2>&1 ) &

exec "$@"
