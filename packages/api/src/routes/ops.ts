import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { registry, registerCollectors } from '../ops/metrics';
import { realProbes } from '../ops/probes';
import { checkReadiness } from '../ops/readiness';
import { NODE_ID, classifyJob, readHeartbeats, registeredJobs } from '../ops/jobs';
import { readBackupStatus } from '../ops/backup-status';
import { processRole } from '../ops/role';

const app = new Hono<AppContext>();

let collectorsRegistered = false;
function ensureCollectors() {
  if (collectorsRegistered) return;
  collectorsRegistered = true;
  registerCollectors(realProbes());
}

const digest = (s: string) => createHash('sha256').update(s).digest();
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Liveness: the process is up. Deliberately touches nothing (no DB, no Redis), so a DB outage never restarts healthy nodes. */
// (GET /health is registered in app.ts)

/** Readiness: 200 when this node can serve traffic (database, Redis, migrations, not draining), else 503. */
app.get('/ready', async (c) => {
  const r = await checkReadiness();
  c.header('Cache-Control', 'no-store');
  return c.json({ status: r.ready ? 'ready' : 'not_ready', checks: r.checks }, r.ready ? 200 : 503);
});

/**
 * Prometheus scrape endpoint. Disabled (404) unless METRICS_TOKEN is set; then it requires
 * `Authorization: Bearer <METRICS_TOKEN>` (401 otherwise). It exposes counts and timings only: no issue keys,
 * no user names or e-mail addresses.
 */
app.get('/metrics', async (c) => {
  const expected = (process.env.METRICS_TOKEN || '').trim();
  if (!expected) return c.json({ errorMessages: ['Resource not found'] }, 404);
  const h = c.req.header('authorization') || '';
  const presented = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : undefined;
  if (!tokenMatches(presented, expected)) {
    c.header('WWW-Authenticate', 'Bearer realm="metrics"');
    return c.json({ errorMessages: ['Unauthorized'] }, 401);
  }
  ensureCollectors();
  return new Response(await registry.render(), {
    status: 200,
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' },
  });
});

/** Background job heartbeats for the admin health page (any node: heartbeats are shared through Redis). */
app.get('/rest/api/2/admin/jobs', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const known = new Map(registeredJobs().map((j) => [j.name, j.everyMs]));
  const beats = await readHeartbeats();
  const jobs = beats.map((b) => {
    const everyMs = 'never' in b ? known.get(b.job) ?? b.everyMs : b.everyMs;
    return { ...b, health: classifyJob(b, everyMs) };
  });
  return c.json({ generatedAt: new Date().toISOString(), node: NODE_ID, role: processRole(), jobs });
});

/** "Last verified backup": reads the status file written by scripts/backup.sh and scripts/restore-verify.sh. */
app.get('/rest/api/2/admin/backup-status', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  return c.json(await readBackupStatus());
});

export default app;
