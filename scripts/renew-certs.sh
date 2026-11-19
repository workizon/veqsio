#!/usr/bin/env bash
set -euo pipefail

# Veqsio SSL Certificate Renewal
# Run daily (or twice daily) via cron for auto-renewal.

VEQSIO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${VEQSIO_DIR}/docker-compose.prod.yml"
DOMAIN="${VEQSIO_DOMAIN:-jira.wup.lv}"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Starting certificate renewal check..."

# Attempt renewal
docker run --rm \
  -v "${VEQSIO_DIR}/nginx/certbot:/etc/letsencrypt" \
  -v "${VEQSIO_DIR}/nginx/certbot-www:/var/www/certbot" \
  -p 80:80 \
  certbot/certbot renew \
  --quiet \
  --no-random-sleep-on-renew

# If certs were renewed, copy them and reload nginx
if [ -d "${VEQSIO_DIR}/nginx/certbot/live/${DOMAIN}" ]; then
  SRC_CHAIN="${VEQSIO_DIR}/nginx/certbot/live/${DOMAIN}/fullchain.pem"
  SRC_KEY="${VEQSIO_DIR}/nginx/certbot/live/${DOMAIN}/privkey.pem"
  DEST_DIR="${VEQSIO_DIR}/nginx/ssl/live/${DOMAIN}"

  mkdir -p "$DEST_DIR"

  # Only copy if changed
  if [ "$SRC_CHAIN" -nt "${DEST_DIR}/fullchain.pem" ] || [ "$SRC_KEY" -nt "${DEST_DIR}/privkey.pem" ]; then
    echo "      Certificates updated. Copying to nginx SSL directory..."
    cp "$SRC_CHAIN" "${DEST_DIR}/fullchain.pem"
    cp "$SRC_KEY" "${DEST_DIR}/privkey.pem"
    docker compose -f "$COMPOSE_FILE" exec nginx nginx -s reload
    echo "      Nginx reloaded."
  else
    echo "      No certificate changes."
  fi
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') — Renewal check complete."
