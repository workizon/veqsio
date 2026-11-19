# Observability

What the API tells you about itself: structured logs, a request id on every response, Prometheus metrics, health and
readiness endpoints, and background-job heartbeats. Community edition, no feature switch; nothing here sends data
anywhere on its own.

| Need | Where |
|---|---|
| Is the process alive? | `GET /health` (liveness, touches nothing) |
| Can this node take traffic? | `GET /ready` (database, Redis, schema version, not draining) |
| Metrics for Prometheus | `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN` (404 until `METRICS_TOKEN` is set) |
| Did the jobs run? Last verified backup? | Administration > Configuration health (`/admin/health`), API `GET /rest/api/2/admin/jobs` and `/admin/backup-status` |
| What happened to request X? | Search the logs for the `request_id` from the `X-Request-Id` response header |

## Structured logs

Every log line is one JSON object on stdout (errors and warnings on stderr):

```json
{"ts":"2026-11-12T08:53:03.114Z","level":"info","msg":"request","request_id":"3f0c0b0e-4c1f-4f0e-9a0b-2f1f8d1c7a11","user_id":42,"method":"GET","route":"/rest/api/2/issue/:idOrKey","status":200,"duration_ms":12}
```

* **One access-log line per request** with `method`, the **route pattern** (never the raw path, so issue keys, slugs
  and reset tokens do not end up in logs), `status`, `duration_ms`, `request_id` and, when signed in, `user_id`.
  `/health`, `/ready` and `/metrics` are logged at `debug` only.
* **Request id:** a well-formed incoming `X-Request-Id` (8-64 characters of `A-Za-z0-9._-`, as set by your proxy) is
  kept, anything else is replaced by a UUID. The id is returned in the `X-Request-Id` response header (also on errors
  and 404s) and is attached to **every** log line written while the request is handled, including the plain
  `console.error('[email] ...')` calls of the existing code: the console is routed through the same logger at startup.
* **Level and format:** `LOG_LEVEL=debug|info|warn|error|silent` (default `info`; `warn` under `NODE_ENV=test`),
  `LOG_FORMAT=json` (default) or `text` for human-readable development output, `raw` to leave the console untouched.
* **No secrets, no personal data.** Query strings, headers, bodies and client addresses are never logged. In addition
  the logger masks, in messages and fields: values of keys that look like credentials (`password`, `token`, `secret`,
  `authorization`, `cookie`, `api_key`, `signature`, `session`, `email`, ...), e-mail addresses, `Bearer`/`Basic`
  credentials, URL passwords, `?token=`/`?code=`/`?key=` parameters and long token-looking strings. This is a safety net,
  not a licence to log secrets on purpose: do not put them in messages.
* **Shipping:** let the container runtime collect stdout (the compose files rotate it with `json-file`), or use
  Promtail/Vector/Fluent Bit/Filebeat to ship to Loki, Elasticsearch or your SIEM. The lines are valid JSON so no
  parser configuration is needed.

## Metrics

Prometheus text format 0.0.4, implemented in-process (`packages/api/src/ops/metrics.ts`); no dependency. The endpoint is
**disabled unless `METRICS_TOKEN` is set**; then `Authorization: Bearer <token>` is required (compared in constant time).
The compose nginx configurations do not proxy `/metrics` publicly: scrape the API on the internal network.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: veqsio-api
    metrics_path: /metrics
    authorization: { type: Bearer, credentials_file: /etc/prometheus/metrics_token }
    static_configs:
      - targets: ['api1:3000', 'api2:3000', 'worker:3000']   # scrape EVERY node: per-node series, sum() in queries
```

Labels are route **patterns**, methods, status classes and fixed job names: never raw paths, user names or ids.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `veqsio_http_requests_total` | counter | `method`, `route`, `status_class` | requests handled |
| `veqsio_http_request_duration_seconds` | histogram | `method`, `route`, `status_class` | latency (5 ms to 10 s buckets) |
| `veqsio_http_requests_in_flight` | gauge | | requests being handled by this node |
| `veqsio_db_up` / `veqsio_db_ping_seconds` | gauge | | PostgreSQL answered a probe / probe round trip |
| `veqsio_db_pool_max_connections` | gauge | | this node's pool size (`DB_POOL_MAX`) |
| `veqsio_db_connections` | gauge | `state` | connections to the database by state (`pg_stat_activity`, all nodes together) |
| `veqsio_db_server_max_connections` | gauge | | server `max_connections` (compare with the sum of all pools) |
| `veqsio_schema_migrations_applied` / `_expected` | gauge | | ledger vs this build |
| `veqsio_redis_up` / `veqsio_redis_ping_seconds` | gauge | `mode` (`redis`/`memory`) | Redis status |
| `veqsio_job_runs_total` | counter | `job`, `result` (`success`, `failure`, `skipped_locked`) | runs of the SLA ticker, e-mail queue, intake snooze, recurring issues, approvals, filter digests, IMAP poller and module jobs |
| `veqsio_job_last_run_timestamp_seconds` | gauge | `job` | last run on this node (any result) |
| `veqsio_job_last_success_timestamp_seconds` | gauge | `job` | last successful run on this node |
| `veqsio_job_last_duration_seconds` | gauge | `job` | duration of the last run |
| `veqsio_queue_depth` | gauge | `queue`, `state` | e-mail `pending`/`failed`, agent runs `queued`/`delivered`/`running`, intake `pending` |
| `veqsio_delivery_failures_24h` | gauge | `kind` (`webhook`, `agent_run`, `email`) | failed deliveries in the last 24 h |
| `veqsio_webhook_deliveries_total`, `veqsio_agent_deliveries_total` | counter | `result` | outgoing webhook / agent deliveries on this node |
| `veqsio_licence_state` | gauge | `state`, `plan` | licence state (1 for the current one) |
| `veqsio_licence_expires_timestamp_seconds` | gauge | | licence expiry (absent without a licence) |
| `veqsio_active_users` | gauge | | distinct users with an authenticated request in the last 15 minutes, on any node |
| `veqsio_realtime_connections` | gauge | | open WebSockets on this node |
| `veqsio_build_info` | gauge | `version`, `build`, `role`, `runtime` | always 1 |
| `veqsio_process_resident_memory_bytes`, `veqsio_process_start_time_seconds`, `veqsio_up` | gauge | | process basics |

Notes and honest limits:

* **DB pool:** the `postgres` driver does not expose in-process pool usage, so the pool is observed from the server side
  (`veqsio_db_connections`, `veqsio_db_ping_seconds`). A rising ping with connections at the pool maximum means
  "pool exhausted".
* **Queue depth, failures and active users are computed at scrape time** with a handful of cheap indexed queries and
  a 3 s timeout; if the database is down they keep their last values and `veqsio_db_up` is 0.
* **Job series are per node.** The job metrics are recorded where the job ran; with advisory locks only one node runs a
  given job per tick, the others count `skipped_locked`. Alert on `time() - max(veqsio_job_last_success_timestamp_seconds)`
  across all nodes, not on one node.
* **SLA:** the SLA ticker is the job `sla-breach`; breach notifications are counted in the logs
  (`[servicedesk] N SLA breach notification(s) sent`). Per-SLA compliance stays in the service desk reports.

### Example alert rules

`prometheus/alerts.example.yml` contains these as a starting point:

```yaml
- alert: VeqsioNotReady
  expr: veqsio_db_up == 0 or on() max(veqsio_redis_up) == 0
  for: 2m
- alert: VeqsioJobStalled        # no node completed the job for 10x its interval; adjust per job
  expr: time() - max by (job) (veqsio_job_last_success_timestamp_seconds) > 600
  for: 5m
- alert: VeqsioJobFailing
  expr: increase(veqsio_job_runs_total{result="failure"}[15m]) > 3
- alert: VeqsioEmailBacklog
  expr: veqsio_queue_depth{queue="email",state="pending"} > 200
  for: 15m
- alert: VeqsioHighErrorRate
  expr: sum(rate(veqsio_http_requests_total{status_class="5xx"}[5m])) / sum(rate(veqsio_http_requests_total[5m])) > 0.02
  for: 10m
- alert: VeqsioSlowRequests
  expr: histogram_quantile(0.95, sum by (le) (rate(veqsio_http_request_duration_seconds_bucket[5m]))) > 1.5
  for: 10m
- alert: VeqsioLicenceExpiring
  expr: veqsio_licence_expires_timestamp_seconds - time() < 14 * 86400
```

## Health, readiness and jobs

* `GET /health`: `{"status":"ok"}`, always 200 while the process runs. Use it for container liveness. It deliberately does
  not check dependencies, so a database outage does not restart healthy API containers.
* `GET /ready`: 200 `{"status":"ready"}` or 503 `{"status":"not_ready"}` with a coarse `checks` list
  (`database`, `redis`, `migrations`, `draining`). The migration check is enforced when the startup schema guard is
  (`NODE_ENV=production` or `REQUIRE_MIGRATIONS=1`). During graceful shutdown it turns 503 first. No hostnames or error
  strings are returned.
* **Job heartbeats:** each run writes `{node, lastRunAt, lastSuccessAt, lastFailureAt, lastDurationMs, lastError, runs,
  failures}` to Redis (7 day TTL). Administration > Configuration health shows them with a state: *Healthy*, *Failing*
  (last run threw), *No recent run* (nothing for 3 intervals, minimum 2 minutes) or *No heartbeat yet*. Because the
  heartbeat lives in Redis, jobs running on a separate `worker` node show up on every node's page. Without Redis
  (`REDIS_URL=memory:`) only this process's jobs are visible.

## Tracing (OpenTelemetry)

Traces are **opt-in**: nothing is loaded or sent until an OTLP endpoint is configured. The API then exports spans over
OTLP/HTTP (JSON) to that endpoint only, using the standard variables:

| Variable | Meaning |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Where to send (the first gets `/v1/traces` appended) |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value,key2=value2`, for example an API key for a hosted collector |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Export timeout in milliseconds |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | Who is sending (`service.name` defaults to `veqsio-api`) |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | What to keep; default `parentbased_always_on`, also `always_off`, `traceidratio`, `parentbased_traceidratio` |
| `OTEL_SDK_DISABLED=true` | Force off |

What you get:

- One server span per HTTP request, named `METHOD /route/pattern`. An incoming W3C `traceparent` is continued, so a trace
  started by your proxy or another service goes through Veqsio.
- One span per background job run.
- One client span per outgoing HTTP call (webhooks, automation webhooks and other calls made through the egress guard), named `METHOD host`, with the status code. Per-query database spans are not produced: the driver does not report timings, so a request span carries the number of queries it ran instead.
- `trace_id` and `span_id` in every JSON log line of that request, next to `request_id`, to jump from a log line to a trace.

What the spans contain, on purpose and nothing else: method, route pattern (not the URL with ids), status code, request id,
number of database queries, and the error type on failures; outgoing calls add only the host and the status code (never the path or query, which can hold tokens). No query text, no parameters, no headers, no bodies, no user
names and no issue content leave the server. A start-up log line names the endpoint host so that you can see where data goes.

## Configuration summary

| Variable | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `LOG_FORMAT` | `json` | `text` for readable lines; `raw` leaves `console.*` untouched |
| `METRICS_TOKEN` | unset | enables `/metrics`; the bearer token Prometheus must send |
| `VEQSIO_ROLE` | `all` | `web`, `worker` or `all`; see [multi-node.md](multi-node.md) |
| `DB_POOL_MAX` | `10` | connections per API node |
| `SHUTDOWN_DRAIN_MS`, `SHUTDOWN_TIMEOUT_MS` | `5000` (production) / `0`, `25000` | graceful shutdown |
| `BACKUP_STATUS_DIR` / `BACKUP_DIR` | `./backups` | where the backup scripts write `last-backup.json` / `last-verify.json` |
| `BACKUP_VERIFY_MAX_AGE_HOURS` | `36` | after this the "Last verified backup" card says verification is overdue |
