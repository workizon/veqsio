# Veqsio Deployment Guide

## Overview

This guide covers deploying Veqsio (Jira clone) using Docker Compose in production. The stack includes:

- **PostgreSQL 15** - primary database
- **Valkey 8** (Redis-compatible; BSD-licensed) - sessions, caching, rate limiting
- **API** (Hono/Bun) - REST API backend
- **Web** (Next.js 15) - frontend application
- **Nginx** - reverse proxy, SSL termination

## Environment Variables

Create a `.env` file in the project root:

```bash
# Database
POSTGRES_USER=veqsio
POSTGRES_PASSWORD=secure_random_password_here
POSTGRES_DB=veqsio
DATABASE_URL=postgresql://veqsio:secure_random_password_here@postgres:5432/veqsio

# Redis
REDIS_URL=redis://redis:6379

# Application
WEB_URL=https://veqsio.example.com
API_PORT=3000
NEXT_PUBLIC_API_URL=https://veqsio.example.com

# Security
SESSION_SECRET=change_me_to_a_32_byte_random_string
```

## Docker Compose Setup

### Production Deployment

```bash
# 1. Clone the repository
git clone https://github.com/workizon/veqsio.git
cd veqsio

# 2. Create environment file
cp .env.example .env
# Edit .env with your production values

# 3. Build and start services
docker compose -f docker-compose.prod.yml up -d --build

# 4. Run database migrations
docker compose -f docker-compose.prod.yml exec api bun run migrate

# 5. Seed initial data (optional)
docker compose -f docker-compose.prod.yml exec api bun run seed
```

### Health Checks

All services include Docker health checks:

```bash
# Check all services
docker compose -f docker-compose.prod.yml ps

# View logs
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f nginx
```

## SSL/TLS with Let's Encrypt

### Option 1: Certbot + Nginx

```bash
# Install Certbot on the host
sudo apt install certbot

# Obtain certificate
sudo certbot certonly --standalone -d veqsio.example.com

# Copy certificates to nginx SSL directory
sudo cp /etc/letsencrypt/live/veqsio.example.com/fullchain.pem ./nginx/ssl/
sudo cp /etc/letsencrypt/live/veqsio.example.com/privkey.pem ./nginx/ssl/
```

### Nginx SSL Configuration

Create `nginx/nginx.conf`:

```nginx
events {
    worker_connections 1024;
}

http {
    upstream api {
        server api:3000;
    }

    upstream web {
        server web:3001;
    }

    server {
        listen 80;
        server_name veqsio.example.com;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name veqsio.example.com;

        ssl_certificate /etc/nginx/ssl/fullchain.pem;
        ssl_certificate_key /etc/nginx/ssl/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;

        # API routes
        location /rest/ {
            proxy_pass http://api;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # Next.js app
        location / {
            proxy_pass http://web;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
}
```

### Option 2: Auto-renewal with Certbot Docker

Add a certbot service to `docker-compose.prod.yml`:

```yaml
  certbot:
    image: certbot/certbot
    container_name: veqsio-certbot
    volumes:
      - ./certbot/conf:/etc/letsencrypt
      - ./certbot/www:/var/www/certbot
    entrypoint: "/bin/sh -c 'trap exit TERM; while :; do certbot renew; sleep 12h & wait $${!}; done;'"
```

## Database migrations and upgrades

The schema is versioned with drizzle migrations in `packages/db/drizzle` (tracked in git). Every schema change ships with a migration; `schema.ts` and the migrations are checked against each other in CI.

- **New installation or upgrade:** `./deploy.sh` runs `bun migrate.ts` in `packages/db` before it starts the new containers and **aborts the deployment if the migration fails**. Take a database backup first (the script writes one to `backups/`).
- **Manual run:** `cd packages/db && DATABASE_URL=postgresql://... bun migrate.ts`. The command is idempotent and exits non-zero on failure.
- **Startup guard:** in production the API refuses to start if the database has fewer migrations than the build expects, and prints what to run. Set `SKIP_SCHEMA_CHECK=1` only for emergencies.
- **Databases created with `drizzle-kit push`** (older development databases) have no migration history. `migrate.ts` refuses to run on them and tells you to back up and run `bun migrate.ts --baseline` once, which records the baseline as applied without executing it. After that, normal migrations apply.
- **Developing a schema change:** edit `packages/db/schema.ts`, run `cd packages/db && bun run db:generate`, review the generated SQL (destructive changes such as dropping a column need a conscious decision and an upgrade note), and commit the SQL, the snapshot and `schema-version.ts` together.

## Backup and Restore

> The maintained procedure is in **[backup-and-recovery.md](backup-and-recovery.md)** (`scripts/backup.sh`, `scripts/restore-verify.sh`, RPO/RTO, PITR, drill checklist). The inline script below is the older minimal example.

### Automated Backups

Create a backup script `scripts/backup.sh`:

```bash
#!/bin/bash
set -e

BACKUP_DIR="/backups"
DATE=$(date +%Y%m%d_%H%M%S)
DB_NAME="${POSTGRES_DB:-veqsio}"
DB_USER="${POSTGRES_USER:-veqsio}"

# Database backup
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$DB_USER" "$DB_NAME" > "$BACKUP_DIR/db_$DATE.sql"

# Compress
 gzip "$BACKUP_DIR/db_$DATE.sql"

# Redis backup (copy RDB)
docker compose -f docker-compose.prod.yml cp redis:/data/dump.rdb "$BACKUP_DIR/redis_$DATE.rdb"

# Cleanup old backups (keep 14 days)
find "$BACKUP_DIR" -type f -mtime +14 -delete

echo "Backup completed: db_$DATE.sql.gz"
```

Add to crontab:

```bash
0 2 * * * /path/to/veqsio/scripts/backup.sh >> /var/log/veqsio-backup.log 2>&1
```

### Restore from Backup

```bash
# Stop API to avoid writes
docker compose -f docker-compose.prod.yml stop api

# Restore database
gunzip -c backups/db_20260101_020000.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U veqsio -d veqsio

# Restart services
docker compose -f docker-compose.prod.yml up -d
```

## Monitoring

See **[observability.md](observability.md)** for structured logs, `/ready`, the token-protected `/metrics` endpoint and alert rules. Running several API nodes: **[multi-node.md](multi-node.md)** (`docker-compose.ha.yml`). REST reference: **[api.md](api.md)**.

### Log Rotation

Docker Compose log rotation is configured in `docker-compose.prod.yml`:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "5"
```

### Prometheus + Grafana (Optional)

Add a `docker-compose.monitoring.yml`:

```yaml
services:
  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana
    ports:
      - "3002:3000"
    volumes:
      - grafana_data:/var/lib/grafana
```

### Health Endpoints

- API: `GET /health` returns `{ "status": "ok" }` (liveness); `GET /ready` checks database, Redis and schema (readiness)
- Database: monitored via Docker health check
- Redis: monitored via Docker health check

## Troubleshooting

### Database Connection Issues

```bash
# Check if Postgres is healthy
docker compose -f docker-compose.prod.yml exec postgres pg_isready

# Verify connection from API container
docker compose -f docker-compose.prod.yml exec api bun -e "console.log('OK')"
```

### Redis Connection Issues

```bash
# Test Redis connectivity
docker compose -f docker-compose.prod.yml exec redis redis-cli ping
```

### Web Build Failures

```bash
# Rebuild web container
docker compose -f docker-compose.prod.yml build --no-cache web
docker compose -f docker-compose.prod.yml up -d web
```

## Upgrade Procedure

For an existing checkout with its production `.env` configured, use the deployment script:

```bash
# Pull latest code
git pull --ff-only origin main

# Back up, migrate, build and restart, in that order
bash deploy.sh
```

Before running versioned migrations, `deploy.sh` writes a PostgreSQL custom-format archive to
`backups/pre-deploy-<UTC timestamp>.<unique suffix>.dump`. It uses `pg_dump` inside the running
PostgreSQL container, with the same database and user as the migration step. The directory is
restricted to its owner and new archives are created with private permissions. Repeated deployments
keep separate archives; the script does not expire or delete older backups.
The deployment user must own an existing `backups/` directory; if Docker previously created it
as root, correct its ownership before deploying. New directories are prepared before Docker starts.

A dump is initially written to a `.partial` file. Only a successful, non-empty dump that passes
`pg_restore --list` is renamed to `.dump`. If dumping, writing or checking the archive fails, the
script removes the partial file and stops before migrations, image builds or application restarts.
If migration fails, the completed backup remains available and deployment stops.

The archive check verifies the table of contents, **not a full restore**. Regular restore drills on
an isolated database and off-host copies are still required. The archive contains the database,
not uploaded files, object storage or cluster-wide roles. PostgreSQL takes a consistent snapshot;
writes after that snapshot are not in the archive. Coordinate a maintenance window when you need
to prevent those writes during an upgrade.

### Check a pre-deploy archive by restoring to a separate database

Use the deployment's `POSTGRES_USER`, choose the exact archive printed by the script, and choose
an unused database name. This example leaves the running application's database intact:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  createdb -U "$POSTGRES_USER" veqsio_restore_check

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d veqsio_restore_check \
  --exit-on-error --single-transaction < 'backups/pre-deploy-<timestamp>.<suffix>.dump'
```

Verify application data and the migration journal in the restored database before planning a
cutover. There is no automatic production rollback: migrating backwards is not supported, and
switching to a restored database also requires compatible application code and a decision about
writes received since the backup. The older `.sql.gz` backups documented above still use `psql`;
the new pre-deploy `.dump` archives use `pg_restore`.

Run `bash scripts/test-deploy.sh` for offline regression checks. These execute the real deploy
script with substituted Docker/Bun commands, covering backup ordering, repeated deployments,
failed or empty dumps, unreadable archives and failed migrations. CI runs the same checks.
