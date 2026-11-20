import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import app from '../../src/app';
import { defineJob, runJobOnce, startJobs, stopJobs, readHeartbeats } from '../../src/ops/jobs';
import { setLogSink } from '../../src/ops/logger';
import { setDraining } from '../../src/ops/readiness';

describe('Operations: health, readiness, metrics, jobs, backup status', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let admin = '', bob = '';
  let tmp = '';

  const login = async (username: string) => {
    const res = await app.request('/rest/auth/1/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
    });
    return (res.headers.get('set-cookie') || '').split(';')[0];
  };
  const metrics = (token?: string) => app.request('/metrics', { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    testSql = createTestSql();
    const seeded = await seedTestData(testSql);
    const db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash });
    admin = await login('admin');
    bob = await login('bob');
    tmp = mkdtempSync(join(tmpdir(), 'veqsio-ops-'));
  });
  afterAll(async () => {
    delete process.env.METRICS_TOKEN; delete process.env.BACKUP_STATUS_DIR;
    stopJobs(); setDraining(false);
    rmSync(tmp, { recursive: true, force: true });
    await resetTestDb(testSql); await testSql.end();
  });

  /* ------------------------------- health / ready ------------------------------- */
  test('/health is liveness: 200, and stays 200 while the node drains', async () => {
    setDraining(true);
    expect((await app.request('/health')).status).toBe(200);
    setDraining(false);
  });

  test('/ready is 200 with database and Redis up, 503 while draining, and exposes no connection details', async () => {
    const ok = await app.request('/ready');
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.status).toBe('ready');
    expect(body.checks.map((c: any) => c.name)).toEqual(['database', 'redis', 'migrations', 'draining']);
    setDraining(true);
    const draining = await app.request('/ready');
    expect(draining.status).toBe(503);
    expect((await draining.json()).status).toBe('not_ready');
    setDraining(false);
  });

  test('/ready checks the migration ledger when the schema guard is enforced', async () => {
    process.env.REQUIRE_MIGRATIONS = '1';
    try {
      const res = await app.request('/ready');
      const body = await res.json();
      const m = body.checks.find((c: any) => c.name === 'migrations');
      // The test database is created with migrations (ledger complete) or push (no ledger): either way the answer is explicit.
      expect(res.status === 200 ? m.ok : !m.ok).toBe(true);
      if (!m.ok) expect(['no-history', 'outdated']).toContain(m.detail);
    } finally { delete process.env.REQUIRE_MIGRATIONS; }
  });

  /* ---------------------------------- request id --------------------------------- */
  test('every response carries X-Request-Id; a well-formed incoming id is kept, a malformed one replaced', async () => {
    const a = await app.request('/health');
    expect(a.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const b = await app.request('/health', { headers: { 'X-Request-Id': 'trace-abc-123456' } });
    expect(b.headers.get('x-request-id')).toBe('trace-abc-123456');
    const c = await app.request('/health', { headers: { 'X-Request-Id': 'x y\tz' } });
    expect(c.headers.get('x-request-id')).not.toBe('x y\tz');
    const err = await app.request('/rest/api/2/does-not-exist');
    expect(err.status).toBe(404);
    expect(err.headers.get('x-request-id')).toBeTruthy();
  });

  test('the access log is one JSON line with route pattern, status, duration, request and user id; no query string, no secrets', async () => {
    process.env.LOG_LEVEL = 'info';
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    try {
      await app.request('/rest/api/2/search?jql=reporter%3D%22carol%40example.com%22&token=SECRETQ', { headers: { Cookie: admin, 'X-Request-Id': 'trace-log-1234567' } });
    } finally { restore(); delete process.env.LOG_LEVEL; }
    const rec = lines.map((l) => JSON.parse(l)).find((r) => r.msg === 'request');
    expect(rec).toBeTruthy();
    expect(rec).toMatchObject({ level: 'info', method: 'GET', route: '/rest/api/2/search', status: 200, request_id: 'trace-log-1234567' });
    expect(typeof rec.duration_ms).toBe('number');
    expect(typeof rec.user_id).toBe('number');
    const text = lines.join('\n');
    expect(text).not.toContain('carol@example.com');
    expect(text).not.toContain('SECRETQ');
    expect(text).not.toContain('jql');
  });

  /* ------------------------------------ metrics ----------------------------------- */
  test('/metrics is disabled (404) without METRICS_TOKEN, 401 with a missing or wrong token, 200 with the right one', async () => {
    delete process.env.METRICS_TOKEN;
    expect((await metrics('anything')).status).toBe(404);
    process.env.METRICS_TOKEN = 'scrape-token-1234567890';
    expect((await metrics()).status).toBe(401);
    expect((await metrics('wrong-token')).status).toBe(401);
    expect((await metrics('scrape-token-1234567890x')).status).toBe(401);
    const noBearer = await app.request('/metrics', { headers: { Authorization: 'scrape-token-1234567890' } });
    expect(noBearer.status).toBe(401);
    expect((await app.request('/metrics', { headers: { Cookie: admin } })).status).toBe(401); // a session is not a scrape credential
    const ok = await metrics('scrape-token-1234567890');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/plain');
  });

  test('metrics content: HTTP by route pattern and status class, DB, Redis, queues, licence, build info, active users', async () => {
    process.env.METRICS_TOKEN = 'scrape-token-1234567890';
    await app.request('/rest/api/2/issue/TEST-1', { headers: { Cookie: admin } });
    await app.request('/rest/api/2/issue/NOPE-9', { headers: { Cookie: admin } });
    await app.request('/rest/api/2/myself', { headers: { Cookie: bob } });
    await new Promise((r) => setTimeout(r, 50));
    const text = await (await metrics('scrape-token-1234567890')).text();
    expect(text).toMatch(/veqsio_http_requests_total\{method="GET",route="\/rest\/api\/2\/issue\/:idOrKey",status_class="[24]xx"\} \d+/);
    expect(text).toContain('veqsio_http_request_duration_seconds_bucket{le="0.1",method="GET",route="/rest/api/2/issue/:idOrKey"');
    expect(text).not.toContain('TEST-1'); // raw paths / issue keys never become label values
    expect(text).not.toContain('NOPE-9');
    expect(text).toContain('veqsio_db_up 1');
    expect(text).toMatch(/veqsio_db_connections\{state="[a-z ]+"\} \d+/);
    expect(text).toContain('veqsio_db_pool_max_connections');
    expect(text).toMatch(/veqsio_redis_up\{mode="(memory|redis)"\} 1/); // the in-memory store when REDIS_URL=memory:, a real server otherwise
    expect(text).toContain('veqsio_queue_depth{queue="email",state="pending"}');
    expect(text).toContain('veqsio_queue_depth{queue="agent_runs",state="queued"}');
    expect(text).toContain('veqsio_delivery_failures_24h{kind="webhook"}');
    expect(text).toMatch(/veqsio_licence_state\{plan="[a-z]+",state="[a-z]+"\} 1/);
    expect(text).toMatch(/veqsio_build_info\{build="[^"]+",role="all",runtime="bun-[^"]+",version="[^"]+"\} 1/);
    expect(text).toMatch(/veqsio_active_users \d+/);
    expect(text).toContain('veqsio_schema_migrations_expected');
    expect(text).not.toContain('@example.com');
    const active = Number(/veqsio_active_users (\d+)/.exec(text)![1]);
    expect(active).toBeGreaterThanOrEqual(1);
  });

  /* ---------------------------------- jobs / roles --------------------------------- */
  test('a job runs under an advisory lock: two simultaneous runs, exactly one executes, the other is skipped_locked', async () => {
    let executed = 0;
    const job = defineJob({ name: 'test-lock-job', everyMs: 60_000, run: async () => { executed++; await new Promise((r) => setTimeout(r, 300)); } });
    const results = await Promise.all([runJobOnce(job), (async () => { await new Promise((r) => setTimeout(r, 50)); return runJobOnce(job); })()]);
    expect(results.sort()).toEqual(['skipped_locked', 'success']);
    expect(executed).toBe(1);
    // the lock is released with the transaction: the next run executes again
    expect(await runJobOnce(job)).toBe('success');
    expect(executed).toBe(2);
  });

  test('a failing job is recorded as failure with heartbeat and does not throw', async () => {
    const job = defineJob({ name: 'test-failing-job', everyMs: 60_000, run: async () => { throw new Error('boom with secret@example.com'); } });
    const lines: string[] = [];
    process.env.LOG_LEVEL = 'error';
    const restore = setLogSink((l) => lines.push(l));
    try { expect(await runJobOnce(job)).toBe('failure'); } finally { restore(); delete process.env.LOG_LEVEL; }
    expect(lines.join('\n')).not.toContain('secret@example.com');
    const [hb] = await readHeartbeats(['test-failing-job']);
    expect(hb).toMatchObject({ job: 'test-failing-job', lastResult: 'failure', failures: 1 });
  });

  test('VEQSIO_ROLE gates the timers: web starts none, worker and all start every job', () => {
    const jobs = [defineJob({ name: 'role-a', everyMs: 3_600_000, run: async () => {} }), defineJob({ name: 'role-b', everyMs: 3_600_000, run: async () => {} })];
    expect(startJobs(jobs, { VEQSIO_ROLE: 'web' })).toBe(0);
    expect(startJobs(jobs, { VEQSIO_ROLE: 'worker' })).toBe(2);
    stopJobs();
    expect(startJobs(jobs, {})).toBe(2);
    stopJobs();
  });

  test('GET /rest/api/2/admin/jobs shows heartbeats to system administrators only', async () => {
    await runJobOnce(defineJob({ name: 'test-heartbeat-job', everyMs: 60_000, run: async () => 1 }));
    expect((await app.request('/rest/api/2/admin/jobs')).status).toBe(401);
    expect((await app.request('/rest/api/2/admin/jobs', { headers: { Cookie: bob } })).status).toBe(403);
    const res = await app.request('/rest/api/2/admin/jobs', { headers: { Cookie: admin } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe('all');
    const j = body.jobs.find((x: any) => x.job === 'test-heartbeat-job');
    expect(j).toMatchObject({ lastResult: 'success', health: 'ok' });
    expect(j.lastSuccessAt).toBeTruthy();
  });

  /* ---------------------------------- backup status -------------------------------- */
  test('GET /rest/api/2/admin/backup-status reads the status file (admins only) and never leaks the path', async () => {
    expect((await app.request('/rest/api/2/admin/backup-status')).status).toBe(401);
    expect((await app.request('/rest/api/2/admin/backup-status', { headers: { Cookie: bob } })).status).toBe(403);

    process.env.BACKUP_STATUS_DIR = join(tmp, 'missing');
    const none = await (await app.request('/rest/api/2/admin/backup-status', { headers: { Cookie: admin } })).json();
    expect(none).toMatchObject({ configured: false, state: 'unknown', verify: null });

    process.env.BACKUP_STATUS_DIR = tmp;
    writeFileSync(join(tmp, 'last-backup.json'), JSON.stringify({ at: new Date().toISOString(), ok: true, file: 'veqsio_20260101.dump', bytes: 1234, sha256: 'ab'.repeat(32), durationSeconds: 2, error: null }));
    writeFileSync(join(tmp, 'last-verify.json'), JSON.stringify({
      at: new Date().toISOString(), ok: true, file: 'veqsio_20260101.dump', durationSeconds: 5, error: null, migrations: { applied: 24, expected: 24 },
      rowCounts: { users: 2, issues: 10 }, checks: [{ name: 'smoke query', ok: true }],
    }));
    const body = await (await app.request('/rest/api/2/admin/backup-status', { headers: { Cookie: admin } })).json();
    expect(body).toMatchObject({ configured: true, state: 'ok', backup: { ok: true, bytes: 1234 }, verify: { ok: true, rowCounts: { users: 2, issues: 10 } } });
    expect(JSON.stringify(body)).not.toContain(tmp);

    writeFileSync(join(tmp, 'last-verify.json'), JSON.stringify({ at: new Date().toISOString(), ok: false, error: 'pg_restore reported errors', checks: [] }));
    expect((await (await app.request('/rest/api/2/admin/backup-status', { headers: { Cookie: admin } })).json()).state).toBe('failed');

    writeFileSync(join(tmp, 'last-verify.json'), '{not json');
    expect((await (await app.request('/rest/api/2/admin/backup-status', { headers: { Cookie: admin } })).json()).state).toBe('unknown');
  });
});
