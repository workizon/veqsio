#!/usr/bin/env bash
# Host-side backup for Veqsio: pg_dump из контейнера + retention.
# Cron (workizon): 0 3 * * * cd /home/workizon/web/jira.wup.lv/public_html && ./scripts/backup-local.sh >> ./backups/backup.log 2>&1
set -euo pipefail

VEQSIO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${VEQSIO_DIR}/backups"
PG_CONTAINER="veqsio-postgres"
PG_USER="${POSTGRES_USER:-veqsio}"
PG_DB="${POSTGRES_DB:-veqsio}"
KEEP_DAYS=14

if [ -f "${VEQSIO_DIR}/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "${VEQSIO_DIR}/.env"; set +a
  PG_USER="${POSTGRES_USER:-veqsio}"
  PG_DB="${POSTGRES_DB:-veqsio}"
fi

mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y%m%d_%H%M%S)
DUMP_FILE="${BACKUP_DIR}/veqsio_${DATE}.sql.gz"

docker exec "$PG_CONTAINER" \
  pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner --no-privileges \
  | gzip > "$DUMP_FILE"

if [ ! -s "$DUMP_FILE" ]; then
  echo "$(date '+%F %T') ERROR: empty dump $DUMP_FILE" >&2
  rm -f "$DUMP_FILE"
  exit 1
fi

find "$BACKUP_DIR" -maxdepth 1 -name 'veqsio_*.sql.gz' -mtime +${KEEP_DAYS} -delete
echo "$(date '+%F %T') OK backup: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"