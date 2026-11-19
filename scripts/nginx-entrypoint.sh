#!/bin/sh
set -e

DOMAIN="${VEQSIO_DOMAIN:-jira.wup.lv}"
SSL_DIR="/etc/nginx/ssl/live/${DOMAIN}"
REAL_CHAIN="${SSL_DIR}/fullchain.pem"
REAL_KEY="${SSL_DIR}/privkey.pem"

# If real Let's Encrypt certs are mounted, use them.
# Otherwise, generate a temporary self-signed certificate so nginx can start
# (required for the initial ACME challenge or local testing).
if [ ! -f "$REAL_CHAIN" ] || [ ! -f "$REAL_KEY" ]; then
  echo "[nginx-entrypoint] SSL certificates not found. Generating temporary self-signed cert for ${DOMAIN}..."
  mkdir -p "$SSL_DIR"
  apk add --no-cache openssl >/dev/null 2>&1
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$REAL_KEY" \
    -out "$REAL_CHAIN" \
    -subj "/CN=${DOMAIN}" \
    >/dev/null 2>&1
  echo "[nginx-entrypoint] Temporary certificate generated."
fi

# Validate configuration before starting
nginx -t

# Start nginx in foreground
exec nginx -g 'daemon off;'
