#!/usr/bin/env bash
# Veqsio restore verification: restores a backup into a SCRATCH database and checks it is usable.
#
#   scripts/restore-verify.sh [--dump FILE] [--scratch-db NAME] [--keep] [--help]
#
# What it does
#   1. picks the newest BACKUP_DIR/veqsio_*.dump (or --dump FILE), checks its sha256 sidecar and that pg_restore can read it
#   2. creates a NEW scratch database (default veqsio_verify_<timestamp>) on the same server
#   3. restores the dump into it (pg_restore --exit-on-error)
#   4. checks: migration ledger == migrations this checkout expects, row counts of key tables (users >= 1),
#      foreign keys exist, a join smoke query returns every issue, no orphaned issues
#   5. drops the scratch database (unless --keep) and writes BACKUP_DIR/last-verify.json for the admin card
#
# Safety
#   - It never connects to the live database for anything but reading the server address. It only creates, fills and drops
#     the scratch database it created itself.
#   - The scratch name must match ^[a-z][a-z0-9_]*$, contain "verify" or "scratch", and differ from the live database name;
#     a database that already exists is never touched.
#   - There is intentionally NO flag to restore over the live database. For a real restore follow docs/backup-and-recovery.md.
#   - Every failure exits non-zero and is recorded in last-verify.json (ok=false).
#
# Connection: same as backup.sh. BACKUP_DATABASE_URL / DATABASE_URL (or VERIFY_SERVER_URL for another server: the role must
# be allowed to CREATE DATABASE), otherwise docker mode with docker-compose.prod.yml and .env credentials.
#
# Environment: BACKUP_DIR (default <repo>/backups), EXPECTED_MIGRATIONS (default: entries in packages/db/drizzle/meta/_journal.json),
#   VERIFY_MIN_USERS (1), VERIFY_ALLOW_SCHEMA_MISMATCH=1 (verify a dump taken before an upgrade).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DUMP=""; SCRATCH=""; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    --dump) DUMP="${2:-}"; shift 2 ;;
    --scratch-db) SCRATCH="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [ -f "$ROOT/.env" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|'#'*|*[!A-Za-z0-9_]*) continue ;; esac
    [ -z "${!key+x}" ] || continue
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    export "$key=$value"
  done < "$ROOT/.env"
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
STATUS_FILE="$BACKUP_DIR/last-verify.json"
STARTED="$(date +%s)"; NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; STAMP="$(date -u +%Y%m%d%H%M%S)"
MIN_USERS="${VERIFY_MIN_USERS:-1}"
umask 077
mkdir -p "$BACKUP_DIR"

json_escape() { printf '%s' "$1" | head -c 400 | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   ' | tr -d '\000-\037'; }
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

DUMP_BASENAME=""; MIG_JSON=null; COUNTS_JSON='{}'; CHECKS=""; CREATED=0; OK=false; ERROR=""
add_check() { # name ok
  CHECKS="${CHECKS:+$CHECKS,}{\"name\":\"$(json_escape "$1")\",\"ok\":$2}"
  if [ "$2" = true ]; then log "  ok    $1"; else log "  FAIL  $1" >&2; fi
}
write_status() {
  local tmp="$STATUS_FILE.tmp.$$"
  printf '{"at":"%s","ok":%s,"file":%s,"bytes":null,"sha256":null,"durationSeconds":%s,"error":%s,"migrations":%s,"rowCounts":%s,"checks":[%s]}\n' \
    "$NOW_ISO" "$OK" "$([ -n "$DUMP_BASENAME" ] && printf '"%s"' "$(json_escape "$DUMP_BASENAME")" || echo null)" \
    "$(( $(date +%s) - STARTED ))" "$([ -n "$ERROR" ] && printf '"%s"' "$(json_escape "$ERROR")" || echo null)" \
    "$MIG_JSON" "$COUNTS_JSON" "$CHECKS" > "$tmp" && mv -f "$tmp" "$STATUS_FILE"
}
cleanup() {
  if [ "$CREATED" = 1 ] && [ "$KEEP" = 0 ]; then
    admin_sql "DROP DATABASE IF EXISTS \"$SCRATCH\"" >/dev/null 2>&1 && log "scratch database $SCRATCH dropped" || echo "WARNING: could not drop scratch database $SCRATCH; drop it manually" >&2
  elif [ "$CREATED" = 1 ]; then
    log "scratch database $SCRATCH kept (--keep); drop it when done"
  fi
  write_status
}
die() { ERROR="$*"; OK=false; echo "RESTORE VERIFICATION FAILED: $*" >&2; exit 1; }
trap cleanup EXIT

# ---- connection --------------------------------------------------------------------------------------------------
SERVER_URL="${VERIFY_SERVER_URL:-${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}}"
MODE=direct; LIVE_DB=""
if [ -z "$SERVER_URL" ]; then
  MODE=docker
  COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker-compose.prod.yml}"
  [ -f "$COMPOSE_FILE" ] || die "no database URL and no compose file at $COMPOSE_FILE"
  command -v docker >/dev/null || die "docker mode needs the docker CLI"
  PGU="${POSTGRES_USER:-veqsio}"; LIVE_DB="${POSTGRES_DB:-veqsio}"
else
  for tool in psql pg_restore; do command -v "$tool" >/dev/null || die "$tool not found in PATH (install postgresql-client)"; done
  url_decode() { printf '%b' "${1//%/\\x}"; }
  re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)'
  [[ "$SERVER_URL" =~ $re ]] || die "database URL is not of the form postgresql://user:password@host:port/database"
  export PGUSER="$(url_decode "${BASH_REMATCH[2]}")" PGPASSWORD="$(url_decode "${BASH_REMATCH[4]:-}")" PGHOST="${BASH_REMATCH[5]}" PGPORT="${BASH_REMATCH[7]:-5432}"
  LIVE_DB="${BASH_REMATCH[8]}"
fi
export PGCONNECT_TIMEOUT=10

# All SQL goes through these three helpers; nothing else talks to the server.
admin_sql() { # connects to the maintenance database "postgres"
  if [ "$MODE" = direct ]; then psql -X -q -At -v ON_ERROR_STOP=1 -d postgres -c "$1"
  else docker compose -f "$COMPOSE_FILE" exec -T postgres psql -X -q -At -v ON_ERROR_STOP=1 -U "$PGU" -d postgres -c "$1"; fi
}
scratch_sql() { # tuples only, unaligned, against the scratch database
  if [ "$MODE" = direct ]; then psql -X -At -v ON_ERROR_STOP=1 -d "$SCRATCH" -c "$1"
  else docker compose -f "$COMPOSE_FILE" exec -T postgres psql -X -At -v ON_ERROR_STOP=1 -U "$PGU" -d "$SCRATCH" -c "$1"; fi
}
restore_into_scratch() {
  if [ "$MODE" = direct ]; then pg_restore --exit-on-error --no-owner --no-privileges --dbname="$SCRATCH" "$DUMP"
  else docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore --exit-on-error --no-owner --no-privileges -U "$PGU" -d "$SCRATCH" < "$DUMP"; fi
}
list_archive() {
  if [ "$MODE" = direct ]; then pg_restore --list "$DUMP" >/dev/null
  else docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore --list < "$DUMP" >/dev/null; fi
}

# ---- choose the dump ---------------------------------------------------------------------------------------------
if [ -z "$DUMP" ]; then
  DUMP="$(ls -1t "$BACKUP_DIR"/veqsio_*.dump 2>/dev/null | head -n1 || true)"
  [ -n "$DUMP" ] || die "no veqsio_*.dump in $BACKUP_DIR (run scripts/backup.sh first)"
fi
[ -f "$DUMP" ] && [ -s "$DUMP" ] || die "dump not found or empty: $DUMP"
DUMP_BASENAME="$(basename "$DUMP")"
log "verifying $DUMP_BASENAME ($(wc -c < "$DUMP" | tr -d ' ') bytes)"

if [ -f "$DUMP.sha256" ]; then
  expected="$(cut -d' ' -f1 "$DUMP.sha256")"; actual="$(sha256sum "$DUMP" | cut -d' ' -f1)"
  [ "$expected" = "$actual" ] || { add_check "checksum matches" false; die "sha256 mismatch: the dump changed after it was written"; }
  add_check "checksum matches" true
else
  log "  note  no .sha256 sidecar next to the dump; checksum not verified"
fi
list_archive || { add_check "archive readable" false; die "pg_restore cannot read the archive"; }
add_check "archive readable" true

# ---- scratch database --------------------------------------------------------------------------------------------
[ -n "$SCRATCH" ] || SCRATCH="veqsio_verify_$STAMP"
[[ "$SCRATCH" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "scratch database name '$SCRATCH' must match ^[a-z][a-z0-9_]*$"
[[ "$SCRATCH" == *verify* || "$SCRATCH" == *scratch* ]] || die "scratch database name '$SCRATCH' must contain 'verify' or 'scratch' (safety rule)"
[ "$SCRATCH" != "$LIVE_DB" ] || die "scratch database equals the live database '$LIVE_DB': refusing"
exists="$(admin_sql "SELECT 1 FROM pg_database WHERE datname = '$SCRATCH'")" || die "cannot connect to the database server (check the URL and credentials)"
[ -z "$exists" ] || die "database '$SCRATCH' already exists: refusing to touch it (choose another --scratch-db)"
admin_sql "CREATE DATABASE \"$SCRATCH\"" || die "cannot create the scratch database (the role needs CREATEDB)"
CREATED=1
log "restoring into scratch database $SCRATCH ..."
restore_into_scratch || { add_check "restore completes without errors" false; die "pg_restore reported errors"; }
add_check "restore completes without errors" true

# ---- checks ------------------------------------------------------------------------------------------------------
FAILED=0
fail_check() { add_check "$1" false; FAILED=1; }

EXPECTED="${EXPECTED_MIGRATIONS:-}"
if [ -z "$EXPECTED" ] && [ -f "$ROOT/packages/db/drizzle/meta/_journal.json" ]; then
  EXPECTED="$(grep -c '"tag"' "$ROOT/packages/db/drizzle/meta/_journal.json")"
fi
APPLIED="$(scratch_sql "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || true)"
if [ -z "$APPLIED" ]; then
  fail_check "migration ledger present (drizzle.__drizzle_migrations)"
elif [ -z "$EXPECTED" ]; then
  MIG_JSON="{\"applied\":$APPLIED,\"expected\":$APPLIED}"; log "  note  expected migration count unknown (no journal); set EXPECTED_MIGRATIONS"
  add_check "migration ledger present ($APPLIED applied)" true
else
  MIG_JSON="{\"applied\":$APPLIED,\"expected\":$EXPECTED}"
  if [ "$APPLIED" = "$EXPECTED" ] || [ "${VERIFY_ALLOW_SCHEMA_MISMATCH:-0}" = 1 ]; then
    add_check "migrations at expected version ($APPLIED of $EXPECTED)" true
  else
    fail_check "migrations at expected version ($APPLIED of $EXPECTED)"
  fi
fi

COUNTS=""
for t in users projects issues comments attachments statuses issue_types workflows system_settings; do
  n="$(scratch_sql "SELECT count(*) FROM public.\"$t\"" 2>/dev/null || true)"
  if [ -z "$n" ]; then fail_check "table $t restored"; continue; fi
  COUNTS="${COUNTS:+$COUNTS,}\"$t\":$n"
  [ "$t" = users ] && USERS="$n"
done
COUNTS_JSON="{$COUNTS}"
if [ "${USERS:-0}" -ge "$MIN_USERS" ] 2>/dev/null; then add_check "users >= $MIN_USERS (found ${USERS:-0})" true; else fail_check "users >= $MIN_USERS (found ${USERS:-0})"; fi

fks="$(scratch_sql "SELECT count(*) FROM pg_constraint WHERE contype = 'f'" 2>/dev/null || echo 0)"
if [ "${fks:-0}" -gt 0 ] 2>/dev/null; then add_check "foreign keys restored ($fks)" true; else fail_check "foreign keys restored"; fi

smoke="$(scratch_sql "SELECT (SELECT count(*) FROM issues i JOIN projects p ON p.id = i.project_id JOIN statuses s ON s.id = i.status_id) || ' ' || (SELECT count(*) FROM issues)" 2>/dev/null || true)"
if [ -n "$smoke" ] && [ "${smoke%% *}" = "${smoke##* }" ]; then add_check "smoke query: every issue joins its project and status (${smoke%% *})" true; else fail_check "smoke query: every issue joins its project and status ($smoke)"; fi

if [ "$FAILED" = 0 ]; then OK=true; log "RESTORE VERIFICATION PASSED"; else ERROR="one or more checks failed"; echo "RESTORE VERIFICATION FAILED: $ERROR" >&2; exit 1; fi
