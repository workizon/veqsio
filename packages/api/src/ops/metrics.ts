/**
 * A tiny Prometheus registry (text exposition format 0.0.4). No dependency: counters, gauges and histograms with
 * labels, plus "collectors" that refresh gauges from the database / Redis at scrape time.
 *
 * Cardinality rule: labels are only ever route PATTERNS (`/rest/api/2/issue/:issueKey`), HTTP methods, status classes
 * and fixed job names, never raw paths, ids, users or e-mail addresses.
 */
type Labels = Record<string, string>;
const keyOf = (labels: Labels) => Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join('\u0001');

function escapeLabel(v: string) { return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"'); }
function fmtLabels(labels: Labels) {
  const parts = Object.keys(labels).sort().map((k) => `${k}="${escapeLabel(String(labels[k]))}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}
function fmtNum(n: number) {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return String(n);
}

abstract class Metric {
  constructor(readonly name: string, readonly help: string, readonly type: 'counter' | 'gauge' | 'histogram') {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`invalid metric name ${name}`);
  }
  abstract render(): string[];
  abstract reset(): void;
  header() { return [`# HELP ${this.name} ${this.help.replace(/\n/g, ' ')}`, `# TYPE ${this.name} ${this.type}`]; }
}

export class Counter extends Metric {
  private series = new Map<string, { labels: Labels; value: number }>();
  constructor(name: string, help: string) { super(name, help, 'counter'); }
  inc(labels: Labels = {}, by = 1) {
    const k = keyOf(labels); const s = this.series.get(k);
    if (s) s.value += by; else this.series.set(k, { labels: { ...labels }, value: by });
  }
  get(labels: Labels = {}) { return this.series.get(keyOf(labels))?.value ?? 0; }
  reset() { this.series.clear(); }
  render() { return [...this.header(), ...[...this.series.values()].map((s) => `${this.name}${fmtLabels(s.labels)} ${fmtNum(s.value)}`)]; }
}

export class Gauge extends Metric {
  private series = new Map<string, { labels: Labels; value: number }>();
  constructor(name: string, help: string) { super(name, help, 'gauge'); }
  set(labels: Labels, value: number) { this.series.set(keyOf(labels), { labels: { ...labels }, value }); }
  inc(labels: Labels = {}, by = 1) { const s = this.series.get(keyOf(labels)); this.set(labels, (s?.value ?? 0) + by); }
  dec(labels: Labels = {}, by = 1) { this.inc(labels, -by); }
  get(labels: Labels = {}) { return this.series.get(keyOf(labels))?.value ?? 0; }
  /** Drop all series (collectors re-set them on each scrape so vanished label values disappear). */
  reset() { this.series.clear(); }
  render() { return [...this.header(), ...[...this.series.values()].map((s) => `${this.name}${fmtLabels(s.labels)} ${fmtNum(s.value)}`)]; }
}

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram extends Metric {
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, readonly buckets: number[] = DEFAULT_BUCKETS) { super(name, help, 'histogram'); }
  observe(labels: Labels, value: number) {
    const k = keyOf(labels);
    let s = this.series.get(k);
    if (!s) { s = { labels: { ...labels }, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }; this.series.set(k, s); }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]) s.counts[i]++;
    s.sum += value; s.count++;
  }
  count(labels: Labels = {}) { return this.series.get(keyOf(labels))?.count ?? 0; }
  reset() { this.series.clear(); }
  render() {
    const out = this.header();
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket${fmtLabels({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      out.push(`${this.name}_bucket${fmtLabels({ ...s.labels, le: '+Inf' })} ${s.count}`);
      out.push(`${this.name}_sum${fmtLabels(s.labels)} ${fmtNum(s.sum)}`);
      out.push(`${this.name}_count${fmtLabels(s.labels)} ${s.count}`);
    }
    return out;
  }
}

export class Registry {
  private metrics = new Map<string, Metric>();
  private collectors: Array<() => Promise<void> | void> = [];
  counter(name: string, help: string) { return this.add(new Counter(name, help)); }
  gauge(name: string, help: string) { return this.add(new Gauge(name, help)); }
  histogram(name: string, help: string, buckets?: number[]) { return this.add(new Histogram(name, help, buckets)); }
  private add<T extends Metric>(m: T): T {
    const existing = this.metrics.get(m.name);
    if (existing) return existing as T;
    this.metrics.set(m.name, m); return m;
  }
  /** Runs before each render; failures are swallowed (a broken collector must not break the scrape). */
  collect(fn: () => Promise<void> | void) { this.collectors.push(fn); }
  async render(): Promise<string> {
    for (const c of this.collectors) { try { await c(); } catch { /* keep scraping */ } }
    return [...this.metrics.values()].map((m) => m.render().join('\n')).join('\n') + '\n';
  }
}

export const registry = new Registry();

/* ----------------------------- application metrics ---------------------------- */

export const httpRequests = registry.counter('veqsio_http_requests_total', 'HTTP requests by method, route pattern and status class.');
export const httpDuration = registry.histogram('veqsio_http_request_duration_seconds', 'HTTP request duration by method, route pattern and status class.');
export const httpInFlight = registry.gauge('veqsio_http_requests_in_flight', 'HTTP requests currently being handled by this node.');
export const jobRuns = registry.counter('veqsio_job_runs_total', 'Background job runs by job and result (success, failure, skipped_locked).');
export const jobLastRun = registry.gauge('veqsio_job_last_run_timestamp_seconds', 'Unix time of the last run of a background job on this node (any result).');
export const jobLastSuccess = registry.gauge('veqsio_job_last_success_timestamp_seconds', 'Unix time of the last successful run of a background job on this node.');
export const jobLastDuration = registry.gauge('veqsio_job_last_duration_seconds', 'Duration of the last run of a background job on this node.');
export const webhookDeliveries = registry.counter('veqsio_webhook_deliveries_total', 'Outgoing webhook deliveries by result (success, failure).');
export const agentDeliveries = registry.counter('veqsio_agent_deliveries_total', 'Agent run deliveries by result (success, failure).');

const g = {
  up: registry.gauge('veqsio_up', '1 while the process serves requests.'),
  build: registry.gauge('veqsio_build_info', 'Build information (always 1).'),
  start: registry.gauge('veqsio_process_start_time_seconds', 'Unix time the process started.'),
  rss: registry.gauge('veqsio_process_resident_memory_bytes', 'Resident memory of the API process.'),
  dbUp: registry.gauge('veqsio_db_up', '1 when PostgreSQL answered a trivial query.'),
  dbPing: registry.gauge('veqsio_db_ping_seconds', 'Round trip of the PostgreSQL probe query.'),
  dbPoolMax: registry.gauge('veqsio_db_pool_max_connections', 'Configured maximum connections of this node\'s pool (DB_POOL_MAX).'),
  dbConns: registry.gauge('veqsio_db_connections', 'Connections to the database by state (pg_stat_activity, all nodes together).'),
  dbMax: registry.gauge('veqsio_db_server_max_connections', 'max_connections of the PostgreSQL server.'),
  redisUp: registry.gauge('veqsio_redis_up', '1 when Redis answered PING (or the in-memory store is used).'),
  redisPing: registry.gauge('veqsio_redis_ping_seconds', 'Round trip of the Redis PING.'),
  queue: registry.gauge('veqsio_queue_depth', 'Rows waiting in a queue (email pending/failed, agent runs active, intake pending).'),
  failures24h: registry.gauge('veqsio_delivery_failures_24h', 'Failed deliveries in the last 24 hours (webhooks, agent runs, e-mail).'),
  licence: registry.gauge('veqsio_licence_state', 'Licence state (1 for the current state label).'),
  licenceExpiry: registry.gauge('veqsio_licence_expires_timestamp_seconds', 'Unix time the licence expires (absent without a licence).'),
  activeUsers: registry.gauge('veqsio_active_users', 'Distinct users with an active session or API token use recently (see docs).'),
  ws: registry.gauge('veqsio_realtime_connections', 'Open WebSocket connections on this node.'),
  migrations: registry.gauge('veqsio_schema_migrations_applied', 'Applied database migrations.'),
  migrationsExpected: registry.gauge('veqsio_schema_migrations_expected', 'Migrations this build expects.'),
};
const startedAt = Date.now();
g.start.set({}, Math.floor(startedAt / 1000));

/**
 * Registers the scrape-time collectors. They take their data through `probes` so that the registry stays free of
 * imports from the database layer (and tests can run without one).
 */
export interface ProbeSet {
  version: string; build: string; role: string;
  db(): Promise<{ ok: boolean; pingSeconds: number; poolMax: number; byState: Record<string, number>; serverMax: number | null; migrationsApplied: number | null; migrationsExpected: number }>;
  redis(): Promise<{ ok: boolean; pingSeconds: number; mode: 'redis' | 'memory' }>;
  queues(): Promise<{ queues: Array<{ queue: string; state: string; n: number }>; failures: Array<{ kind: string; n: number }>; activeUsers: number }>;
  licence(): { state: string; plan: string; expiresAt: string | null };
  realtimeConnections(): number;
}

export function registerCollectors(p: ProbeSet) {
  g.up.set({}, 1);
  g.build.set({ version: p.version, build: p.build, role: p.role, runtime: `bun-${Bun.version}` }, 1);
  registry.collect(async () => {
    g.rss.set({}, process.memoryUsage().rss);
    g.ws.set({}, p.realtimeConnections());
    const lic = p.licence();
    g.licence.reset(); g.licence.set({ state: lic.state, plan: lic.plan }, 1);
    g.licenceExpiry.reset();
    if (lic.expiresAt) g.licenceExpiry.set({}, Math.floor(Date.parse(lic.expiresAt) / 1000));
  });
  registry.collect(async () => {
    try {
      const d = await withTimeout(p.db(), 3000);
      g.dbUp.set({}, d.ok ? 1 : 0); g.dbPing.set({}, d.pingSeconds); g.dbPoolMax.set({}, d.poolMax);
      g.dbConns.reset(); for (const [state, n] of Object.entries(d.byState)) g.dbConns.set({ state }, n);
      if (d.serverMax != null) g.dbMax.set({}, d.serverMax);
      if (d.migrationsApplied != null) g.migrations.set({}, d.migrationsApplied);
      g.migrationsExpected.set({}, d.migrationsExpected);
    } catch { g.dbUp.set({}, 0); }
    try {
      const r = await withTimeout(p.redis(), 2000);
      g.redisUp.reset(); g.redisUp.set({ mode: r.mode }, r.ok ? 1 : 0); g.redisPing.set({}, r.pingSeconds);
    } catch { g.redisUp.reset(); g.redisUp.set({ mode: 'redis' }, 0); }
    try {
      const q = await withTimeout(p.queues(), 3000);
      g.queue.reset(); for (const x of q.queues) g.queue.set({ queue: x.queue, state: x.state }, x.n);
      g.failures24h.reset(); for (const x of q.failures) g.failures24h.set({ kind: x.kind }, x.n);
      g.activeUsers.set({}, q.activeUsers);
    } catch { /* leave previous values; db_up shows the problem */ }
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}
