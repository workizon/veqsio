#!/usr/bin/env bash
# Tests scripts/backup.sh and scripts/restore-verify.sh against a real PostgreSQL server (pg_dump / pg_restore / psql
# must be installed). It creates throw-away databases named bktest_*, never touches anything else, and removes them.
#
#   TEST_PG_ADMIN_URL=postgresql://veqsio:veqsio@localhost:5432/postgres bash scripts/test-backup-restore.sh
#
# The role needs CREATEDB. Exit status is non-zero when any check fails.
set -uo pipefail
cd "$(dirname "$0")/.."
ADMIN_URL="${TEST_PG_ADMIN_URL:-postgresql://veqsio:veqsio@localhost:5432/postgres}"
BASE="${ADMIN_URL%/*}"
SRC="bktest_verify_src_$$"; OTHER="bktest_verify_other_$$"
T="$(mktemp -d)"; FAILS=0
ok()   { echo "ok: $*"; }
bad()  { echo "FAIL: $*" >&2; FAILS=$((FAILS + 1)); }
expect_ok()   { local name="$1"; shift; if "$@" >"$T/out.log" 2>&1; then ok "$name"; else bad "$name (exit $?)"; sed 's/^/    /' "$T/out.log" >&2; fi; }
expect_fail() { local name="$1"; shift; if "$@" >"$T/out.log" 2>&1; then bad "$name (expected a failure, got success)"; else ok "$name"; fi; }
jqv() { grep -o "\"$1\":[^,}]*" "$2" | head -n1 | cut -d: -f2- | tr -d '"'; }
cleanup() {
  for d in "$SRC" "$OTHER"; do psql -X -q -d "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$d\"" >/dev/null 2>&1; done
  rm -rf "$T"
}
trap cleanup EXIT

command -v psql >/dev/null && command -v pg_dump >/dev/null && command -v pg_restore >/dev/null || { echo "psql, pg_dump and pg_restore are required" >&2; exit 2; }
psql -X -q -d "$ADMIN_URL" -c "SELECT 1" >/dev/null 2>&1 || { echo "cannot connect with TEST_PG_ADMIN_URL" >&2; exit 2; }

# A miniature of the real schema: the ledger, the tables the verifier counts, and the foreign keys its smoke query uses.
psql -X -q -d "$ADMIN_URL" -c "CREATE DATABASE \"$SRC\"" -c "CREATE DATABASE \"$OTHER\""
psql -X -q -v ON_ERROR_STOP=1 -d "$BASE/$SRC" >/dev/null <<'SQL'
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('a', 1), ('b', 2), ('c', 3);
CREATE TABLE users (id serial PRIMARY KEY, username text);
CREATE TABLE projects (id serial PRIMARY KEY, name text);
CREATE TABLE statuses (id serial PRIMARY KEY, name text);
CREATE TABLE issues (id serial PRIMARY KEY, project_id int NOT NULL REFERENCES projects(id), status_id int NOT NULL REFERENCES statuses(id), summary text);
CREATE TABLE comments (id serial PRIMARY KEY, issue_id int REFERENCES issues(id), body text);
CREATE TABLE attachments (id serial PRIMARY KEY);
CREATE TABLE issue_types (id serial PRIMARY KEY);
CREATE TABLE workflows (id serial PRIMARY KEY);
CREATE TABLE system_settings (key text PRIMARY KEY, value text);
INSERT INTO users (username) VALUES ('admin'), ('bob');
INSERT INTO projects (name) VALUES ('P');
INSERT INTO statuses (name) VALUES ('Open');
INSERT INTO issues (project_id, status_id, summary) SELECT 1, 1, 'issue ' || g FROM generate_series(1, 25) g;
INSERT INTO comments (issue_id, body) SELECT 1, 'c' FROM generate_series(1, 5);
SQL
LIVE_URL="$BASE/$SRC"
live_state() { psql -X -At -d "$LIVE_URL" -c "SELECT (SELECT count(*) FROM users)||'/'||(SELECT count(*) FROM issues)||'/'||(SELECT count(*) FROM comments)"; }
BEFORE="$(live_state)"
dbs_before="$(psql -X -At -d "$ADMIN_URL" -c "SELECT count(*) FROM pg_database")"

export BACKUP_DIR="$T/backups" DATABASE_URL="$LIVE_URL" EXPECTED_MIGRATIONS=3
unset BACKUP_DATABASE_URL VERIFY_SERVER_URL BACKUP_UPLOADS_DIR BACKUP_COPY_ENV BACKUP_S3_ENDPOINT

# 1. backup
expect_ok "backup.sh creates a verified custom-format dump" bash scripts/backup.sh
DUMP="$(ls -1 "$BACKUP_DIR"/veqsio_*.dump | head -n1)"
[ -s "$DUMP" ] && ok "dump file exists and is not empty" || bad "dump file missing"
[ "$(stat -c %a "$DUMP")" = 600 ] && ok "dump is private (mode 600)" || bad "dump permissions are $(stat -c %a "$DUMP")"
[ "$(jqv ok "$BACKUP_DIR/last-backup.json")" = true ] && ok "last-backup.json says ok" || bad "last-backup.json not ok"
( cd "$BACKUP_DIR" && sha256sum -c "$(basename "$DUMP").sha256" >/dev/null 2>&1 ) && ok "sha256 sidecar verifies" || bad "sha256 sidecar"
ls "$BACKUP_DIR"/*.partial >/dev/null 2>&1 && bad "partial file left behind" || ok "no .partial files left"

# 2. verification passes and cleans up
expect_ok "restore-verify.sh passes on the fresh dump" bash scripts/restore-verify.sh
[ "$(jqv ok "$BACKUP_DIR/last-verify.json")" = true ] && ok "last-verify.json says ok" || bad "last-verify.json not ok"
grep -q '"issues":25' "$BACKUP_DIR/last-verify.json" && grep -q '"users":2' "$BACKUP_DIR/last-verify.json" && ok "row counts recorded (issues 25, users 2)" || bad "row counts missing"
grep -q '"applied":3,"expected":3' "$BACKUP_DIR/last-verify.json" && ok "migration version recorded" || bad "migration version missing"
[ "$(psql -X -At -d "$ADMIN_URL" -c "SELECT count(*) FROM pg_database WHERE datname LIKE 'veqsio_verify_%'")" = 0 ] && ok "scratch database was dropped" || bad "scratch database left behind"
[ "$(live_state)" = "$BEFORE" ] && ok "live database unchanged" || bad "live database changed"

# 3. safety rules
expect_fail "refuses a scratch database equal to the live one" bash scripts/restore-verify.sh --scratch-db "$SRC"
expect_fail "refuses an already existing database" bash scripts/restore-verify.sh --scratch-db "$OTHER"
psql -X -At -d "$ADMIN_URL" -c "SELECT 1 FROM pg_database WHERE datname = '$OTHER'" | grep -q 1 && ok "the existing database was not dropped" || bad "existing database was dropped!"
expect_fail "refuses a scratch name without verify/scratch" bash scripts/restore-verify.sh --scratch-db postgres
expect_fail "refuses a scratch name that needs quoting" bash scripts/restore-verify.sh --scratch-db 'verify";drop'
expect_fail "unknown arguments are errors" bash scripts/restore-verify.sh --into-live

# 4. detects problems
cp "$DUMP" "$T/good.dump"; cp "$DUMP.sha256" "$T/good.dump.sha256"
head -c 2000 "$T/good.dump" > "$T/trunc.dump"
expect_fail "a truncated dump fails verification" bash scripts/restore-verify.sh --dump "$T/trunc.dump"
[ "$(jqv ok "$BACKUP_DIR/last-verify.json")" = false ] && ok "failure is recorded in last-verify.json" || bad "failure not recorded"
cp "$T/good.dump" "$T/tampered.dump"; printf 'x' >> "$T/tampered.dump"; cp "$T/good.dump.sha256" "$T/tampered.dump.sha256"
expect_fail "a modified dump fails the checksum" bash scripts/restore-verify.sh --dump "$T/tampered.dump"
EXPECTED_MIGRATIONS=5 expect_fail "a migration version mismatch fails" bash scripts/restore-verify.sh
EXPECTED_MIGRATIONS=5 VERIFY_ALLOW_SCHEMA_MISMATCH=1 expect_ok "...unless a mismatch is explicitly allowed" bash scripts/restore-verify.sh
VERIFY_MIN_USERS=50 expect_fail "too few users fails" bash scripts/restore-verify.sh
expect_fail "no dump at all fails" env BACKUP_DIR="$T/empty" bash scripts/restore-verify.sh
[ "$(psql -X -At -d "$ADMIN_URL" -c "SELECT count(*) FROM pg_database WHERE datname LIKE 'veqsio_verify_%'")" = 0 ] && ok "no scratch databases left after failures" || bad "scratch databases left after failures"

# 5. backup failure modes are loud
expect_fail "backup of a missing database fails" env DATABASE_URL="$BASE/bktest_does_not_exist_$$" BACKUP_DIR="$T/b2" bash scripts/backup.sh
[ "$(jqv ok "$T/b2/last-backup.json")" = false ] && ok "backup failure is recorded" || bad "backup failure not recorded"
ls "$T/b2"/veqsio_*.dump >/dev/null 2>&1 && bad "failed backup left a dump" || ok "failed backup leaves no dump"
expect_fail "copying .env without a gpg recipient is refused" env BACKUP_COPY_ENV=1 BACKUP_DIR="$T/b3" bash scripts/backup.sh
expect_fail "malformed database URL is refused" env DATABASE_URL="not-a-url" BACKUP_DIR="$T/b4" bash scripts/backup.sh

# 6. retention only touches our own files
touch -d '30 days ago' "$BACKUP_DIR/veqsio_20200101T000000Z.dump" "$BACKUP_DIR/veqsio_20200101T000000Z.dump.sha256"
touch -d '30 days ago' "$BACKUP_DIR/notes-keep-me.txt"
expect_ok "backup.sh runs again (retention)" bash scripts/backup.sh
[ -e "$BACKUP_DIR/veqsio_20200101T000000Z.dump" ] && bad "old dump was not deleted" || ok "old dump deleted by retention"
[ -e "$BACKUP_DIR/notes-keep-me.txt" ] && ok "unrelated old file kept" || bad "retention deleted a foreign file"
[ "$(ls -1 "$BACKUP_DIR"/veqsio_2026*.dump "$BACKUP_DIR"/veqsio_20[2-9]*Z.dump 2>/dev/null | wc -l)" -ge 2 ] && ok "recent dumps kept" || bad "recent dumps missing"

# 7. uploads archive
mkdir -p "$T/uploads/a" && echo hello > "$T/uploads/a/file.txt"
BACKUP_UPLOADS_DIR="$T/uploads" expect_ok "uploads directory is archived" bash scripts/backup.sh
ls "$BACKUP_DIR"/veqsio_uploads_*.tar.gz >/dev/null 2>&1 && tar -tzf "$(ls -1 "$BACKUP_DIR"/veqsio_uploads_*.tar.gz | head -n1)" | grep -q 'a/file.txt' && ok "uploads archive contains the file" || bad "uploads archive wrong"

[ "$(live_state)" = "$BEFORE" ] && ok "live database still unchanged at the end" || bad "live database changed"
[ "$(psql -X -At -d "$ADMIN_URL" -c "SELECT count(*) FROM pg_database")" = "$dbs_before" ] && ok "no databases left behind" || bad "database count changed"

echo
if [ "$FAILS" -eq 0 ]; then echo "all backup/restore checks passed"; else echo "$FAILS check(s) FAILED" >&2; exit 1; fi
