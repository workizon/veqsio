#!/usr/bin/env bash
# Veqsio backup: PostgreSQL custom-format dump (+ optional uploads archive and encrypted .env copy), verified,
# with retention and a status file for the admin "Last verified backup" card.
#
# It is READ-ONLY with respect to the database (pg_dump takes a consistent snapshot, no locks that block writers) and
# only ever deletes files in BACKUP_DIR that match its own naming pattern.
#
# Connection (first match wins):
#   1. BACKUP_DATABASE_URL or DATABASE_URL            e.g. postgresql://veqsio:secret@db.internal:5432/veqsio
#   2. docker mode (no URL set): `docker compose -f docker-compose.prod.yml exec postgres pg_dump`, credentials from .env
#
# Environment (all optional):
#   BACKUP_DIR              where dumps go                                   (default: <repo>/backups)
#   BACKUP_KEEP_DAILY       days to keep daily dumps                          (default: 7)
#   BACKUP_KEEP_WEEKLY      weeks to keep the Sunday copy in weekly/          (default: 4)
#   BACKUP_UPLOADS_DIR      directory with attachments when STORAGE_TYPE=mock/local disk; archived as tar.gz
#   BACKUP_COPY_ENV         1 = also store an ENCRYPTED copy of .env (needs BACKUP_GPG_RECIPIENT; never written in clear)
#   BACKUP_GPG_RECIPIENT    gpg recipient (key id / e-mail) for the .env copy
#   BACKUP_S3_ENDPOINT / BACKUP_S3_BUCKET / BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY   optional off-site copy (rclone or aws cli)
#   BACKUP_COMPRESSION      pg_dump -Z level 0-9                              (default: 6)
#
# Object storage (STORAGE_TYPE=r2/s3) is NOT backed up by this script: enable versioning / replication on the bucket.
# Exit status is non-zero on ANY failure; the status file then records ok=false.
#
# Cron example:  0 3 * * * cd /opt/veqsio && ./scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
case "${1:-}" in -h|--help) usage; exit 0 ;; "") ;; *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;; esac

# Load .env only for variables that are not already set in the environment.
if [ -f "$ROOT/.env" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|'#'*|*[!A-Za-z0-9_]*) continue ;; esac
    [ -z "${!key+x}" ] || continue
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    export "$key=$value"
  done < "$ROOT/.env"
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
COMPRESSION="${BACKUP_COMPRESSION:-6}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STARTED="$(date +%s)"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATUS_FILE="$BACKUP_DIR/last-backup.json"
DUMP_NAME="veqsio_${STAMP}.dump"

json_escape() { printf '%s' "$1" | head -c 400 | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   ' | tr -d '\000-\037'; }
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

write_status() { # ok file bytes sha error
  local tmp="$STATUS_FILE.tmp.$$"
  printf '{"at":"%s","ok":%s,"file":%s,"bytes":%s,"sha256":%s,"durationSeconds":%s,"error":%s}\n' \
    "$NOW_ISO" "$1" \
    "$([ -n "$2" ] && printf '"%s"' "$2" || echo null)" "${3:-null}" \
    "$([ -n "$4" ] && printf '"%s"' "$4" || echo null)" "$(( $(date +%s) - STARTED ))" \
    "$([ -n "$5" ] && printf '"%s"' "$(json_escape "$5")" || echo null)" > "$tmp"
  mv -f "$tmp" "$STATUS_FILE"
}
PARTIAL=""
fail() {
  echo "BACKUP FAILED: $*" >&2
  [ -n "$PARTIAL" ] && rm -f -- "$PARTIAL"
  write_status false "" null "" "$*" || true
  exit 1
}
trap '[ -n "$PARTIAL" ] && rm -f -- "$PARTIAL"' EXIT

# ---- connection --------------------------------------------------------------------------------------------------
DB_URL="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
MODE=direct
if [ -z "$DB_URL" ]; then
  MODE=docker
  COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker-compose.prod.yml}"
  [ -f "$COMPOSE_FILE" ] || fail "no BACKUP_DATABASE_URL/DATABASE_URL and no compose file at $COMPOSE_FILE"
  command -v docker >/dev/null || fail "docker mode needs the docker CLI"
else
  command -v pg_dump >/dev/null || fail "pg_dump not found in PATH (install postgresql-client)"
  command -v pg_restore >/dev/null || fail "pg_restore not found in PATH (install postgresql-client)"
  url_decode() { printf '%b' "${1//%/\\x}"; }
  re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)'
  [[ "$DB_URL" =~ $re ]] || fail "database URL is not of the form postgresql://user:password@host:port/database"
  export PGUSER="$(url_decode "${BASH_REMATCH[2]}")" PGPASSWORD="$(url_decode "${BASH_REMATCH[4]:-}")" PGHOST="${BASH_REMATCH[5]}" PGPORT="${BASH_REMATCH[7]:-5432}"
  PGDB="${BASH_REMATCH[8]}"
fi

# ---- 1. database dump --------------------------------------------------------------------------------------------
PARTIAL="$BACKUP_DIR/$DUMP_NAME.partial"
log "[1/5] dumping the database ($MODE mode) ..."
if [ "$MODE" = direct ]; then
  pg_dump --format=custom --compress="$COMPRESSION" --no-owner --no-privileges --dbname="$PGDB" --file="$PARTIAL" \
    || fail "pg_dump failed"
else
  PGU="${POSTGRES_USER:-veqsio}"; PGD="${POSTGRES_DB:-veqsio}"
  docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dump -U "$PGU" -d "$PGD" --format=custom --compress="$COMPRESSION" --no-owner --no-privileges > "$PARTIAL" \
    || fail "pg_dump (docker) failed"
fi
[ -s "$PARTIAL" ] || fail "the dump is empty"

log "[2/5] verifying the archive can be read ..."
if [ "$MODE" = direct ]; then
  pg_restore --list "$PARTIAL" > /dev/null || fail "pg_restore cannot read the archive (corrupt dump)"
else
  docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore --list < "$PARTIAL" > /dev/null || fail "pg_restore cannot read the archive (corrupt dump)"
fi
DUMP_FILE="$BACKUP_DIR/$DUMP_NAME"
mv -- "$PARTIAL" "$DUMP_FILE"; PARTIAL=""
BYTES="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
SHA="$(sha256sum "$DUMP_FILE" | cut -d' ' -f1)"
printf '%s  %s\n' "$SHA" "$DUMP_NAME" > "$DUMP_FILE.sha256"
log "      $DUMP_NAME  ${BYTES} bytes  sha256 ${SHA:0:12}..."

# ---- 3. uploads and secrets ---------------------------------------------------------------------------------------
if [ -n "${BACKUP_UPLOADS_DIR:-}" ]; then
  [ -d "$BACKUP_UPLOADS_DIR" ] || fail "BACKUP_UPLOADS_DIR=$BACKUP_UPLOADS_DIR is not a directory"
  log "[3/5] archiving uploads from $BACKUP_UPLOADS_DIR ..."
  tar -czf "$BACKUP_DIR/veqsio_uploads_${STAMP}.tar.gz" -C "$BACKUP_UPLOADS_DIR" . || fail "uploads archive failed"
else
  log "[3/5] no BACKUP_UPLOADS_DIR: attachments are assumed to live in object storage (enable bucket versioning/replication)"
fi
if [ "${BACKUP_COPY_ENV:-0}" = 1 ]; then
  [ -n "${BACKUP_GPG_RECIPIENT:-}" ] || fail "BACKUP_COPY_ENV=1 needs BACKUP_GPG_RECIPIENT: .env holds SECRETS_ENCRYPTION_KEY and is never copied in clear text"
  [ -f "$ROOT/.env" ] || fail "no $ROOT/.env to copy"
  gpg --batch --yes --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$BACKUP_DIR/veqsio_env_${STAMP}.env.gpg" "$ROOT/.env" || fail "gpg encryption of .env failed"
  log "      encrypted .env copy written (store the private key elsewhere!)"
fi

# ---- 4. off-site copy ---------------------------------------------------------------------------------------------
if [ -n "${BACKUP_S3_ENDPOINT:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ] && [ -n "${BACKUP_S3_ACCESS_KEY:-}" ] && [ -n "${BACKUP_S3_SECRET_KEY:-}" ]; then
  log "[4/5] copying to ${BACKUP_S3_BUCKET} ..."
  if command -v rclone >/dev/null; then
    rclone copy "$DUMP_FILE" ":s3,provider=Other,env_auth=false,access_key_id=${BACKUP_S3_ACCESS_KEY},secret_access_key=${BACKUP_S3_SECRET_KEY},endpoint=${BACKUP_S3_ENDPOINT}:${BACKUP_S3_BUCKET}/daily/" || fail "rclone copy failed"
  elif command -v aws >/dev/null; then
    AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" aws s3 cp "$DUMP_FILE" "s3://${BACKUP_S3_BUCKET}/daily/" --endpoint-url "$BACKUP_S3_ENDPOINT" || fail "aws s3 cp failed"
  else
    fail "off-site copy configured but neither rclone nor aws CLI is installed"
  fi
else
  log "[4/5] off-site copy not configured (BACKUP_S3_*): a backup on the same disk is not a disaster-recovery backup"
fi

# ---- 5. retention (only our own file names) ----------------------------------------------------------------------
log "[5/5] retention: daily ${KEEP_DAILY} days, weekly ${KEEP_WEEKLY} weeks"
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'veqsio_*.dump' -o -name 'veqsio_*.dump.sha256' -o -name 'veqsio_uploads_*.tar.gz' -o -name 'veqsio_env_*.env.gpg' \) -mtime "+${KEEP_DAILY}" -delete
if [ "$(date -u +%u)" = 7 ]; then
  mkdir -p "$BACKUP_DIR/weekly"
  cp -- "$DUMP_FILE" "$BACKUP_DIR/weekly/$DUMP_NAME"
  find "$BACKUP_DIR/weekly" -maxdepth 1 -type f -name 'veqsio_*.dump' -mtime "+$((KEEP_WEEKLY * 7))" -delete
fi

write_status true "$DUMP_NAME" "$BYTES" "$SHA" ""
log "backup complete: $DUMP_FILE"
log "NEXT: run scripts/restore-verify.sh to prove this dump restores (a backup nobody restored is a hope, not a backup)."
