# Running several API nodes

Veqsio's API is stateless enough to run as N replicas behind a load balancer, with shared PostgreSQL, Redis and object
storage. **Sticky sessions are not required.** This page records what was audited in the code, the settings that matter,
and a checklist to verify a deployment. A runnable example is `docker-compose.ha.yml` (two API replicas, one worker, two
web replicas, nginx, MinIO).

## Topology

```
            clients
               |
        load balancer (nginx / Caddy / cloud LB)   X-Request-Id, X-Forwarded-For (1 trusted hop)
        /               \
   api1 (web)         api2 (web)          worker (jobs)       web1 / web2 (Next.js)
        \               |                  /
         PostgreSQL   Redis   object storage (S3 / R2 / MinIO)
```

## Roles: `VEQSIO_ROLE`

| Value | HTTP + WebSocket | Background jobs | Use |
|---|---|---|---|
| `all` (default) | yes | yes | single node, or every node (jobs are lock-protected) |
| `web` | yes | no | replicas behind the load balancer |
| `worker` | listens (for `/health`, `/ready`, `/metrics`) | yes | one or two nodes, **not** in the balancer's upstream |

An invalid value stops the process at startup. The jobs are: e-mail queue, SLA breach ticker, filter digests, intake
snooze wake-up, approvals expiry/reminders, IMAP poller, LDAP/AD sync, recurring issues and all module jobs.

**Even with `all` on every node jobs never double-run:** each run executes inside a transaction holding
`pg_try_advisory_xact_lock(hash(job name))`. A node that does not get the lock skips the tick (`skipped_locked` in
`veqsio_job_runs_total`). The lock disappears with the transaction, so a crashed node never blocks a job. Before this
change the e-mail queue and SLA ticker ran on every node and could send mail twice; the others were already idempotent
(recurring runs have a unique slot row, IMAP and LDAP have DB leases) and are now simply also locked.

## Audit: what is node-local, what is shared

| Concern | State | Multi-node behaviour |
|---|---|---|
| Sessions, WebSocket tickets | Redis | shared |
| Login throttling, API rate limits | Redis sorted sets | shared; counted across nodes |
| Search/issue/permission cache | Redis with generation keys | shared; invalidation is global |
| Real-time hub (connections, subscriptions) | per-node memory | **events and presence fan out through Redis pub/sub** (`realtime/hub.ts`, `startRedisFanout`). If Redis fan-out is down, delivery degrades to the local node only. `/ws` needs WebSocket upgrade support and long read timeouts in the balancer; no stickiness needed because the client reconnects anywhere |
| Feature switches, instance settings, project feature cache | per-node memory, **5 s TTL** | a change made on node A is visible on node B within 5 s |
| Licence | per-node memory, refreshed every 60 s from env/DB | installing a key is effective cluster-wide within about a minute |
| OIDC discovery/JWKS caches | per-node memory, TTL | harmless |
| Job heartbeats, active users | Redis | shared |
| Module/plugin/automation hooks | registered per node at startup | identical on every node of one build |
| **Attachments** | object storage, **except `STORAGE_TYPE=mock`** (local disk) | `mock` is development-only; use `s3`/`r2`. With a local directory every node must mount the same shared volume |
| **Migration/import uploads** (`MIGRATION_UPLOAD_DIR`, default `/tmp`) | node-local file; the import then runs in the process that received the upload | run Jira/XML imports through one node (e.g. directly to the worker) or mount a shared volume at `MIGRATION_UPLOAD_DIR` |
| Outgoing webhooks and agent deliveries | sent from the node that handled the request, retried in-process | a node that dies mid-retry loses that delivery (the delivery log shows it) |
| Schema migrations | `bun packages/db/migrate.ts` | run **once** per upgrade, never from every replica |

Things that must be identical on every node: `DATABASE_URL`, `REDIS_URL`, **`SECRETS_ENCRYPTION_KEY`**, `WEB_URL`,
`BASE_URL`, storage settings, `OIDC_REDIRECT_BASE_URL`, licence variables.

## Health, readiness, shutdown

* `GET /health`: liveness, always 200 while the process runs.
* `GET /ready`: 200 only when PostgreSQL and Redis answer, the schema has at least the migrations the build expects
  (enforced in production / `REQUIRE_MIGRATIONS=1`) and the node is not draining; otherwise 503 with a coarse reason.
  Use it for the balancer's health check and the container `healthcheck`.
* **Graceful shutdown (SIGTERM/SIGINT):** `/ready` turns 503 immediately, the node waits `SHUTDOWN_DRAIN_MS` (default
  5000 in production) so the balancer stops sending traffic, stops the job timers, stops listening, waits up to
  `SHUTDOWN_TIMEOUT_MS` (25000) for in-flight requests, closes WebSockets and the database pool and exits 0. Set the
  orchestrator's grace period above the sum (`stop_grace_period: 40s`, Kubernetes `terminationGracePeriodSeconds`).
  A job that is running is not interrupted; if the process is killed hard, its lock is released with the connection.

## Load balancer requirements

* Round robin or least-connections; **no stickiness**.
* Active health check on `/ready` (nginx open source only has passive checks: `max_fails`; the example uses both
  `proxy_next_upstream` and the container health checks).
* WebSocket upgrade on `/ws`, read timeout >= 1 h.
* Add `X-Forwarded-For` (append) and set `TRUSTED_PROXY_HOPS` to the number of proxies **you** control in front of the
  API (default 1). The rate limiter takes the address that many entries from the right, so clients cannot choose their own
  bucket.
* Pass or generate `X-Request-Id`; the API echoes it and logs it.
* Do **not** expose `/metrics` publicly; scrape each node on the internal network with `METRICS_TOKEN`.
* Body limit at least `STORAGE_MAX_FILE_SIZE` (100 MiB default).

## Upgrades without downtime

1. Back up (`scripts/backup.sh`) and make sure the last restore verification is green.
2. Apply migrations once (additive by policy, so the old version keeps working against the new schema).
3. Roll the nodes one at a time: SIGTERM, wait for exit, start the new image, wait for `/ready` 200, next node.
4. Roll the worker last (or first, briefly accept that jobs pause for a minute).

## Verification checklist

Run after building a new topology and after changes to it.

- [ ] `curl -s lb/health` is 200 and `curl -s lb/rest/api/2/serverInfo` returns the same build from both nodes (repeat 10
      times; compare `X-Request-Id` and the nodes' logs).
- [ ] Sign in through the balancer, then request `/rest/api/2/myself` 10 times: always 200 (sessions are shared).
- [ ] Open the same issue in two browsers that land on different nodes; comment in one: the other updates live
      (Redis fan-out). Check `veqsio_realtime_connections` on both nodes.
- [ ] Upload an attachment, download it repeatedly: works regardless of the node (object storage).
- [ ] Stop `api1` (`docker stop`): after the drain, requests keep working through `api2`, `/ready` of `api1` was 503
      before it exited; start it again and see it return to rotation.
- [ ] Jobs run once: set `VEQSIO_ROLE=all` on two nodes temporarily, queue an e-mail (test mail) and confirm exactly one
      delivery; `veqsio_job_runs_total{result="skipped_locked"}` increases on one node. Switch back to `web` + `worker`.
- [ ] Administration > Configuration health > Background jobs lists every job as *Healthy*, with the worker as node.
- [ ] Rate limit is shared: hammer `/rest/auth/1/session` with wrong passwords through the balancer; the 429 arrives after
      the configured count in total, not per node.
- [ ] Change an Instance setting on one node (e.g. the announcement banner); the other shows it within ~5 s.
- [ ] `kill -9` the worker mid-job, start another: the job resumes at its next tick (no stuck lock).
- [ ] Rolling restart (above) loses no request: run a loop of `curl -fsS lb/rest/api/2/serverInfo` during it.

## Known limits

* nginx open source cannot health-check actively; for hard guarantees use an LB that polls `/ready`.
* Realtime presence relies on Redis pub/sub; with Redis down, live updates and presence are limited to one node while the
  API otherwise keeps working (sessions need Redis, so sign-in does not).
* The example compose file was validated with `docker compose config` but the topology was **not** started in the build
  sandbox (no Docker daemon); the advisory-lock, role, readiness and shutdown behaviour is covered by automated tests
  (`src/ops/ops.test.ts`, `tests/integration/ops.api.ts`), and the verification checklist above is the manual part.
