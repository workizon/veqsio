#!/usr/bin/env bash
set -euo pipefail

# Veqsio SSL Initialization with Let's Encrypt
# Usage: ./scripts/init-ssl.sh
# Run once on the server to obtain the first certificate.

VEQSIO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${VEQSIO_DIR}/docker-compose.prod.yml"
DOMAIN="${VEQSIO_DOMAIN:-jira.wup.lv}"
EMAIL="${VEQSIO_SSL_EMAIL:-admin@wup.lv}"

echo "========================================"
echo "Veqsio SSL Initialization"
echo "========================================"
echo "Domain: $DOMAIN"
echo "Email:  $EMAIL"

# Ensure nginx is running so Certbot can complete the HTTP challenge
echo "[1/4] Starting nginx..."
docker compose -f "$COMPOSE_FILE" up -d nginx

# Wait for nginx to be ready
sleep 3

# Ensure certbot webroot exists
mkdir -p "${VEQSIO_DIR}/nginx/certbot"

echo "[2/4] Requesting certificate from Let's Encrypt..."
docker run -it --rm \
  -v "${VEQSIO_DIR}/nginx/certbot:/etc/letsencrypt" \
  -v "${VEQSIO_DIR}/nginx/certbot-www:/var/www/certbot" \
  certbot/certbot certonly \
  --standalone \
  --preferred-challenges http \
  -d "$DOMAIN" \
  --agree-tos \
  --no-eff-email \
  -m "$EMAIL" \
  --keep-until-expiring \
  --non-interactive

# Create/update SSL directory for nginx container
echo "[3/4] Updating nginx SSL mounts..."
mkdir -p "${VEQSIO_DIR}/nginx/ssl/live/${DOMAIN}"

# Symlink or copy certs into the nginx SSL volume path
if [ -d "${VEQSIO_DIR}/nginx/certbot/live/${DOMAIN}" ]; then
  cp "${VEQSIO_DIR}/nginx/certbot/live/${DOMAIN}/fullchain.pem" "${VEQSIO_DIR}/nginx/ssl/live/${DOMAIN}/"
  cp "${VEQSIO_DIR}/nginx/certbot/live/${DOMAIN}/privkey.pem" "${VEQSIO_DIR}/nginx/ssl/live/${DOMAIN}/"
  echo "      Certificates installed."
else
  echo "      WARNING: Expected cert directory not found. Check certbot output."
fi

echo "[4/4] Reloading nginx..."
docker compose -f "$COMPOSE_FILE" exec nginx nginx -s reload || true

echo "========================================"
echo "SSL initialization complete."
echo "========================================"
echo ""
echo "To set up auto-renewal, add this to root crontab:"
echo "  0 2 * * * cd ${VEQSIO_DIR} && ./scripts/renew-certs.sh >> ${VEQSIO_DIR}/logs/certbot-renew.log 2>&1"
