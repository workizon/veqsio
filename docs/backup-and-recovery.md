# Backup, restore and disaster recovery

A backup nobody has restored is a hope, not a backup. Veqsio ships two scripts that make the restore part routine:

| Script | Does | Touches the live database? |
|---|---|---|
| `scripts/backup.sh` | `pg_dump` in custom format, integrity check, sha256, optional uploads archive and encrypted `.env`, retention, status file | read-only (a snapshot dump) |
| `scripts/restore-verify.sh` | restores the newest dump into a **scratch database**, checks it, drops it, writes a status file | no: only creates and drops its own `veqsio_verify_*` database |
| `scripts/test-backup-restore.sh` | tests both scripts against a real PostgreSQL (also runs in CI) | no: uses throw-away `bktest_*` databases |

Administration > Configuration health shows the **Last verified backup** card (state *Verified*, *Verification is overdue*,
*Last verification failed* or *Never verified*) from the files the scripts write.

## What to back up

| What | Where it lives | How |
|---|---|---|
| **PostgreSQL** (everything: issues, users, settings, audit log, encrypted secrets) | the `postgres` volume / your managed database | `scripts/backup.sh` (daily) + WAL archiving for point-in-time recovery (below) |
| **Attachments** | object storage (`STORAGE_TYPE=r2/s3`) or the local directory with `STORAGE_TYPE=mock` (`MOCK_STORAGE_DIR`, `/app/uploads` in the compose file) | object storage: bucket **versioning + replication/lifecycle** at your provider (`backup.sh` cannot copy a bucket). Local directory: `BACKUP_UPLOADS_DIR=...` makes `backup.sh` archive it |
| **`SECRETS_ENCRYPTION_KEY`** | `.env` | **Without it every stored secret is unreadable** (SSO client secrets, SMTP password, webhook/plugin/agent signing secrets, AI and integration keys). Store it in a password manager / secrets vault, separately from the database dump. A dump without the key restores fine but those secrets must be re-entered |
| **Licence key** (Enterprise) | `VEQSIO_LICENSE_KEY` / `VEQSIO_LICENSE_PUBLIC_KEYS` in `.env`, or saved in Administration > System > Licence (then it is in the database) | keep the licence token from your purchase mail with your other credentials |
| **`.env` / deployment config** | the server | `BACKUP_COPY_ENV=1` with `BACKUP_GPG_RECIPIENT=...` stores an **encrypted** copy next to each dump; the script refuses to copy it in clear text. Also keep nginx/Caddy config and your compose overrides in git |
| Valkey (Redis-compatible) | `valkey_data` | **not needed**: it holds sessions, caches, rate-limit counters and job heartbeats. After a Redis loss users sign in again; nothing else is lost |

## RPO and RTO: what to promise

| Setup | RPO (data you can lose) | RTO (time to be back) | Notes |
|---|---|---|---|
| Daily `backup.sh` only | up to 24 h | 30-60 min for a few GB (dump restore + start) | the default; fine for small teams |
| Daily dump + hourly dump | up to 1 h | same | cron `0 * * * *` is cheap for small databases |
| Dump + **WAL archiving / PITR** | seconds to a few minutes | 1-2 h (base backup + WAL replay) | the right answer when losing a day of tickets is not acceptable |
| Managed PostgreSQL with PITR + replica | seconds | minutes (failover) | the provider's SLA is your RPO/RTO |

Measure your own RTO with the drill below: it is dominated by dump size and disk speed, not by Veqsio. The
verification job prints and records its duration (`durationSeconds` in `last-verify.json`), which is a lower bound for
the restore step. A reference point from this repository's own test: a 0.5 MB demo database dumps in under a second and
restores in about one second; plan with your real size.

## Daily backup

```bash
# one-off
DATABASE_URL=postgresql://veqsio:SECRET@db.internal:5432/veqsio ./scripts/backup.sh

# Docker Compose production stack (uses the `backup` profile and ./backups)
docker compose -f docker-compose.prod.yml --profile backup run --rm backup

# cron (host): 03:00 backup, 03:30 verification; mail on failure with MAILTO
MAILTO=ops@example.com
0 3  * * * cd /opt/veqsio && docker compose -f docker-compose.prod.yml --profile backup run --rm backup
30 3 * * * cd /opt/veqsio && docker compose -f docker-compose.prod.yml --profile backup run --rm backup-verify
```

What `backup.sh` does, in order: dumps into `veqsio_<UTC timestamp>.dump.partial` (custom format, compressed), checks that
`pg_restore --list` can read it, renames it to its final name (so a half-written file is never mistaken for a backup),
writes `veqsio_<ts>.dump.sha256`, archives `BACKUP_UPLOADS_DIR` if set, writes the encrypted `.env` copy if asked, copies
the dump off-site if `BACKUP_S3_*` is set (rclone or aws cli), applies retention, and writes `last-backup.json`. **Any
failure exits non-zero, removes the partial file and records `ok:false`.**

Files are created with mode 600 in a directory with mode 700. Retention (`BACKUP_KEEP_DAILY`=7 days,
`BACKUP_KEEP_WEEKLY`=4 weeks of Sunday copies) deletes only files matching `veqsio_*.dump`, their `.sha256`,
`veqsio_uploads_*.tar.gz` and `veqsio_env_*.env.gpg`.

**Off-site is not optional for disaster recovery.** A backup on the same disk or host dies with it. Set `BACKUP_S3_*`
(different provider or region than the primary) or copy `backups/` yourself (restic, borg, rclone, a second site).
Encrypt before it leaves the host if the target is not yours.

### Pointing the API at the status files

The API only reads two small JSON files; it never runs a script. In the production compose file `./backups` is mounted
read-only at `/app/backups` (the API's default). For other layouts set `BACKUP_STATUS_DIR` for the API to the directory
that holds `last-backup.json` and `last-verify.json`. The card turns amber when the last successful verification is older
than `BACKUP_VERIFY_MAX_AGE_HOURS` (36) and red when it failed.

## Restore verification

```bash
./scripts/restore-verify.sh                 # newest dump in ./backups
./scripts/restore-verify.sh --dump backups/veqsio_20261112T030001Z.dump
./scripts/restore-verify.sh --keep          # keep the scratch database for manual inspection
```

It checks, and records each result in `last-verify.json`:

1. the sha256 sidecar matches and `pg_restore --list` can read the archive;
2. a **new** database `veqsio_verify_<timestamp>` is created and the dump restored into it with `--exit-on-error`;
3. the migration ledger holds exactly the number of migrations this checkout expects (`EXPECTED_MIGRATIONS` overrides;
   `VERIFY_ALLOW_SCHEMA_MISMATCH=1` allows verifying a dump taken before an upgrade);
4. row counts of the key tables (`users`, `projects`, `issues`, `comments`, `attachments`, `statuses`, `issue_types`,
   `workflows`, `system_settings`) and at least `VERIFY_MIN_USERS` (1) users;
5. foreign keys exist, and a smoke query joins every issue to its project and status (no orphans);
6. the scratch database is dropped (also after a failure).

Safety rules built into the script: the scratch name must match `^[a-z][a-z0-9_]*$`, contain `verify` or `scratch`, differ
from the live database, and **must not exist yet**; there is deliberately no flag to restore over the live database. The
database role needs `CREATEDB`; on a managed service without it, use `VERIFY_SERVER_URL` to point at another server
(a restore-test instance) where it has. Verification proves the *database* restores and is consistent; it cannot prove
that attachments in object storage are intact: spot-check one download in the drill.

## Restoring for real

Plan: restore into a **new** database, check it, then switch the API over. Never restore over a database you have not
backed up first.

```bash
# 0. Declare the incident, note the time. Stop writers: stop the API nodes (the worker too).
docker compose -f docker-compose.prod.yml stop api

# 1. Safety copy of whatever is left, even if it looks broken
./scripts/backup.sh    # may fail if the database is gone: that is fine, continue

# 2. Create an empty database and restore the chosen dump (newest verified one)
createdb -h DBHOST -U postgres veqsio_restored
pg_restore -h DBHOST -U postgres --no-owner --no-privileges --exit-on-error -d veqsio_restored backups/veqsio_<ts>.dump
#    Docker: docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U veqsio --no-owner -d veqsio_restored < backups/veqsio_<ts>.dump

# 3. If the dump is older than the code you run, bring the schema forward (idempotent, fails loudly)
DATABASE_URL=postgresql://veqsio:SECRET@DBHOST:5432/veqsio_restored bun packages/db/migrate.ts

# 4. Switch: rename databases (or change POSTGRES_DB / DATABASE_URL) so the API uses the restored one
psql -h DBHOST -U postgres -c 'ALTER DATABASE veqsio RENAME TO veqsio_broken' -c 'ALTER DATABASE veqsio_restored RENAME TO veqsio'

# 5. Restore attachments if they were lost (bucket versioning / the uploads archive), put SECRETS_ENCRYPTION_KEY back
# 6. Start the API, then run the checklist below
docker compose -f docker-compose.prod.yml up -d api
```

After a restore: sessions are in Redis and survive (or all users sign in again, harmless); issue changes after the dump
time are gone (the RPO) and users should be told the time; e-mails queued in `email_queue` after the dump are lost;
webhooks and integrations keep working (their secrets are in the restored data, decrypted with the same
`SECRETS_ENCRYPTION_KEY`); full-text search needs nothing (PostgreSQL-native).

### Restore drill checklist (do this quarterly and after every major upgrade)

Run it on a spare machine or in a maintenance window; write down the times.

- [ ] Find the newest dump **without** looking at the primary server (from the off-site copy: download it).
- [ ] Verify the checksum: `sha256sum -c veqsio_<ts>.dump.sha256`.
- [ ] Provision a clean PostgreSQL (same major version as production) and an empty Redis.
- [ ] Restore (steps 2-3 above). **Time it.** This is your measured RTO for the database.
- [ ] Start the API of the *same version* against it with the production `.env` (or the `.env.gpg` copy; decrypt with the
      private key you keep elsewhere). Check `/ready` is 200.
- [ ] Sign in as an administrator; open a recent issue; confirm its latest comment is there. Compare the newest issue
      key with the one you expect.
- [ ] Open an issue with an attachment and download it (object storage reachable? bucket restored?).
- [ ] Administration > System: SSO and SMTP settings show as configured (proves `SECRETS_ENCRYPTION_KEY` is right); send a
      test e-mail.
- [ ] Administration > Licence shows the expected plan.
- [ ] Run `scripts/restore-verify.sh` on the same dump and confirm *Verified*.
- [ ] Record: dump age (actual RPO), restore duration, API start time, anything surprising. Update this page for your site.
- [ ] Destroy the drill environment (it holds a copy of production data).

## Point-in-time recovery (WAL archiving outline)

Dumps give you "yesterday 03:00". To recover to "10:41 today" archive the write-ahead log. Outline for a self-managed
PostgreSQL 15/16 (managed services have this as a checkbox; use theirs):

1. **Archive WAL continuously** (`postgresql.conf`):
   ```
   wal_level = replica
   archive_mode = on
   archive_command = 'test ! -f /mnt/wal-archive/%f && cp %p /mnt/wal-archive/%f'   # or pgBackRest / WAL-G to object storage
   archive_timeout = 300      # at most 5 minutes of data in an unarchived segment
   ```
   In production use **pgBackRest** or **WAL-G**: they handle compression, encryption, retention, parallelism and
   verification, which a bare `cp` does not (a full archive disk stops the database).
2. **Take base backups** regularly (`pg_basebackup -D /backups/base_$(date +%F) -Ft -z -Xs -P`, or `pgbackrest backup`).
   Keep base backup + all WAL since it; test the combination.
3. **Recover to a time:** restore the base backup into a new data directory, create `recovery.signal`, set
   `restore_command = 'cp /mnt/wal-archive/%f %p'` and `recovery_target_time = '2026-11-12 10:41:00+00'`,
   `recovery_target_action = promote`, start PostgreSQL, wait for "recovery stopping before..." / promotion, point the API
   at it. Run `restore-verify.sh` logic (row counts, smoke query) against the recovered instance by hand.
4. Alert on archiving failures (`pg_stat_archiver.failed_count`, `last_failed_time`) and on archive volume usage; both
   silently end PITR.

This repository does not automate PITR; the scripts and the card cover the dump-based path. Do not claim a PITR RPO until you
have restored from it at least once.

## Upgrade and rollback

Migrations are **forward-only** (additive by policy, but not reversible by tooling). The rollback story is therefore
"restore the pre-upgrade dump and run the previous image":

1. Announce a window; make sure the last `restore-verify.sh` is green.
2. `./scripts/backup.sh` (deploy.sh and the installer also take a pre-migration dump into `backups/pre-deploy-*.dump`).
3. Stop traffic to the old version or drain nodes; apply migrations **once** (`bun packages/db/migrate.ts`, the `migrate`
   container, or `deploy.sh`). Never let several API replicas race to migrate.
4. Start the new version; check `/ready`, the Configuration health page, and the error rate for 15-30 minutes.
5. **Roll back only if the new version is broken and data written since the upgrade can be discarded (or exported):**
   stop the API, restore the pre-upgrade dump into a new database (steps 2-4 of "Restoring for real"), start the *previous*
   image against it. Running the previous image against the upgraded schema is possible only for additive-only
   migrations and is not guaranteed; the API logs a warning when the database is newer than the build.
6. Keep the pre-upgrade dump until the new version has run a week.

Multi-node: upgrade with the schema first, then roll the nodes one by one (drain with SIGTERM, see
[multi-node.md](multi-node.md)); mixed versions must tolerate the additive schema, which the migration policy ensures.

## Known limitations

* Object storage content is not copied by `backup.sh` (use the provider's versioning/replication).
* No automated PITR, no automated off-site retention beyond the local pattern, no rotation tool for
  `SECRETS_ENCRYPTION_KEY` (re-enter the secrets after changing it).
* `restore-verify.sh` runs where `psql`/`pg_restore` are installed or inside the postgres container; its migration check
  needs `packages/db/drizzle/meta/_journal.json` (checkout) or `EXPECTED_MIGRATIONS`.
* The scripts were tested against PostgreSQL 16 with PostgreSQL 16 client tools and a miniature schema
  (`scripts/test-backup-restore.sh`) and against the full demo database; the Docker modes are syntax-checked and the
  compose files validated, but were not run end to end in the build sandbox (no Docker daemon).
