import { describe, expect, test } from 'bun:test';
import { Registry } from './metrics';
import { log, redact, scrubString, setLogSink, requestContext } from './logger';
import { processRole, runsJobs, servesTraffic } from './role';
import { parseStatus } from './backup-status';
import { classifyJob, lockKey } from './jobs';
import { gracefulShutdown } from './shutdown';
import { isDraining, setDraining, checkReadiness } from './readiness';
import { resolveRequestId } from '../middleware/request-log';

describe('metrics registry', () => {
  test('renders counters, gauges and histograms in Prometheus text format with escaped labels', async () => {
    const r = new Registry();
    const c = r.counter('t_requests_total', 'help');
    c.inc({ route: '/a/:id', status_class: '2xx' }); c.inc({ route: '/a/:id', status_class: '2xx' }, 2);
    const g = r.gauge('t_up', 'up'); g.set({ note: 'a"b\\c\nd' }, 1);
    const h = r.histogram('t_dur_seconds', 'dur', [0.1, 1]);
    h.observe({ route: '/x' }, 0.05); h.observe({ route: '/x' }, 0.5); h.observe({ route: '/x' }, 5);
    const out = await r.render();
    expect(out).toContain('# TYPE t_requests_total counter');
    expect(out).toContain('t_requests_total{route="/a/:id",status_class="2xx"} 3');
    expect(out).toContain('t_up{note="a\\"b\\\\c\\nd"} 1');
    expect(out).toContain('t_dur_seconds_bucket{le="0.1",route="/x"} 1');
    expect(out).toContain('t_dur_seconds_bucket{le="1",route="/x"} 2');
    expect(out).toContain('t_dur_seconds_bucket{le="+Inf",route="/x"} 3');
    expect(out).toContain('t_dur_seconds_count{route="/x"} 3');
    expect(out.endsWith('\n')).toBe(true);
  });
  test('a failing collector does not break the scrape', async () => {
    const r = new Registry();
    r.gauge('t_g', 'g').set({}, 1);
    r.collect(() => { throw new Error('boom'); });
    expect(await r.render()).toContain('t_g 1');
  });
});

describe('structured logging', () => {
  const capture = (fn: () => void) => { const lines: string[] = []; const restore = setLogSink((l) => lines.push(l)); try { fn(); } finally { restore(); } return lines; };

  test('emits one JSON object per line with request id and user id from the request context', () => {
    process.env.LOG_LEVEL = 'info';
    const lines = capture(() => requestContext.run({ requestId: 'req-12345678', userId: 7 }, () => log('info', 'hello', { route: '/x' })));
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ level: 'info', msg: 'hello', request_id: 'req-12345678', user_id: 7, route: '/x' });
    expect(typeof rec.ts).toBe('string');
    delete process.env.LOG_LEVEL;
  });
  test('LOG_LEVEL filters', () => {
    process.env.LOG_LEVEL = 'error';
    expect(capture(() => log('info', 'no'))).toHaveLength(0);
    expect(capture(() => log('error', 'yes'))).toHaveLength(1);
    delete process.env.LOG_LEVEL;
  });
  test('secrets and personal data never reach the log', () => {
    process.env.LOG_LEVEL = 'info';
    const lines = capture(() => log('warn', 'login for alice@example.com with Bearer abcdefgh12345678 at https://u:pw@host/x?token=SECRETVALUE', {
      password: 'hunter2', Authorization: 'Bearer zzzzzzzzzz', nested: { apiKey: 'k', email: 'bob@example.com', ok: 'fine' }, note: 'mail carol@example.org', url: 'https://x.test/cb?code=abc123&state=1',
    }));
    const text = lines.join('\n');
    for (const leaked of ['alice@example.com', 'abcdefgh12345678', 'hunter2', 'zzzzzzzzzz', 'bob@example.com', 'carol@example.org', 'SECRETVALUE', 'u:pw@', 'abc123']) expect(text).not.toContain(leaked);
    expect(text).toContain('fine');
    delete process.env.LOG_LEVEL;
  });
  test('redact bounds depth and scrubString masks token shapes', () => {
    expect(JSON.stringify(redact({ a: { b: { c: { d: { e: 1 } } } } }))).toContain('[truncated]');
    expect(scrubString('key ' + 'a'.repeat(48))).toContain('[redacted]');
  });
  test('request ids: well-formed incoming ids are kept, others replaced', () => {
    expect(resolveRequestId('abc-12345678')).toBe('abc-12345678');
    expect(resolveRequestId('bad id\r\nX: y')).not.toContain('bad');
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('process role', () => {
  test('all runs jobs and serves traffic, web only serves, worker only runs jobs', () => {
    expect(processRole({})).toBe('all');
    expect(runsJobs({ VEQSIO_ROLE: 'all' })).toBe(true); expect(servesTraffic({ VEQSIO_ROLE: 'all' })).toBe(true);
    expect(runsJobs({ VEQSIO_ROLE: 'web' })).toBe(false); expect(servesTraffic({ VEQSIO_ROLE: 'web' })).toBe(true);
    expect(runsJobs({ VEQSIO_ROLE: 'WORKER' })).toBe(true); expect(servesTraffic({ VEQSIO_ROLE: 'worker' })).toBe(false);
  });
  test('an invalid role fails loudly instead of silently running everything', () => {
    expect(() => processRole({ VEQSIO_ROLE: 'api' })).toThrow(/Invalid VEQSIO_ROLE/);
  });
});

describe('jobs', () => {
  test('lock keys are stable, distinct per job and fit a signed bigint', () => {
    expect(lockKey('email-queue')).toBe(lockKey('email-queue'));
    expect(lockKey('email-queue')).not.toBe(lockKey('sla-breach'));
    expect(lockKey('x') >= -(2n ** 63n) && lockKey('x') < 2n ** 63n).toBe(true);
  });
  test('classification: never, failing, stale, ok', () => {
    const base = { job: 'j', node: 'n', everyMs: 60_000, lastSuccessAt: null, lastFailureAt: null, lastDurationMs: 1, lastError: null, runs: 1, failures: 0 };
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(classifyJob({ never: true }, 60_000, now)).toBe('never');
    expect(classifyJob({ ...base, lastRunAt: '2026-01-01T11:59:30Z', lastResult: 'success' }, 60_000, now)).toBe('ok');
    expect(classifyJob({ ...base, lastRunAt: '2026-01-01T11:50:00Z', lastResult: 'success' }, 60_000, now)).toBe('stale');
    expect(classifyJob({ ...base, lastRunAt: '2026-01-01T11:59:50Z', lastResult: 'failure' }, 60_000, now)).toBe('failing');
  });
});

describe('backup status file parsing', () => {
  const now = Date.parse('2026-06-02T00:00:00Z');
  test('fresh successful verification is ok, old is stale, failed is failed, nothing is unknown', () => {
    const v = (at: string, ok = true) => ({ verify: { at, ok, file: 'veqsio_x.dump', rowCounts: { users: 3, 'bad name!': 1 }, migrations: { applied: 24, expected: 24 }, checks: [{ name: 'smoke', ok: true }] } });
    expect(parseStatus(v('2026-06-01T20:00:00Z'), now).state).toBe('ok');
    expect(parseStatus(v('2026-05-20T20:00:00Z'), now).state).toBe('stale');
    expect(parseStatus(v('2026-06-01T20:00:00Z', false), now).state).toBe('failed');
    expect(parseStatus({}, now).state).toBe('unknown');
    expect(parseStatus('garbage', now).state).toBe('unknown');
  });
  test('untrusted content is re-typed and bounded', () => {
    const p = parseStatus({ verify: { at: '2026-06-01T20:00:00Z', ok: true, error: 'x'.repeat(5000), rowCounts: { users: 3, 'bad name!': 1, evil: '<script>' } } }, now);
    expect(p.verify?.rowCounts).toEqual({ users: 3 });
    expect(p.verify?.error?.length).toBe(400);
  });
});

describe('graceful shutdown and readiness', () => {
  test('SIGTERM flips readiness to draining first, stops jobs and listening, waits for in-flight requests, closes the pool, exits 0', async () => {
    const order: string[] = [];
    let inflight = 2;
    let exitCode = -1;
    let readyWhileDraining = null as boolean | null;
    await gracefulShutdown('SIGTERM', {
      stopListening: () => { order.push('stopListening'); },
      forceClose: () => { order.push('forceClose'); },
      stopJobs: () => { order.push('stopJobs'); },
      closeDb: async () => { order.push('closeDb'); },
      inFlight: () => inflight,
      sleep: async () => {
        if (readyWhileDraining === null) readyWhileDraining = !isDraining();
        inflight = Math.max(0, inflight - 1);
      },
      exit: (c) => { exitCode = c; },
    }, { SHUTDOWN_DRAIN_MS: '1000', SHUTDOWN_TIMEOUT_MS: '5000' });
    expect(readyWhileDraining).toBe(false);
    expect(order).toEqual(['stopJobs', 'stopListening', 'forceClose', 'closeDb']);
    expect(exitCode).toBe(0);
    expect(inflight).toBe(0);
    setDraining(false);
  });

  test('readiness: all dependencies up is ready; each failing dependency makes the node not ready; draining too', async () => {
    const up = { db: async () => ({ ok: true }), redis: async () => ({ ok: true, mode: 'redis' }), migrations: async () => 24, enforceMigrations: () => true };
    const { EXPECTED_MIGRATIONS } = await import('@veqsio/db');
    const good = { ...up, migrations: async () => EXPECTED_MIGRATIONS };
    expect((await checkReadiness(good)).ready).toBe(true);
    expect((await checkReadiness({ ...good, db: async () => ({ ok: false, error: 'conn refused to 10.0.0.5' }) })).ready).toBe(false);
    expect((await checkReadiness({ ...good, redis: async () => ({ ok: false, mode: 'redis' }) })).ready).toBe(false);
    const old = await checkReadiness({ ...good, migrations: async () => EXPECTED_MIGRATIONS - 1 });
    expect(old.ready).toBe(false);
    expect(old.checks.find((c) => c.name === 'migrations')?.detail).toBe('outdated');
    expect((await checkReadiness({ ...good, enforceMigrations: () => false, migrations: async () => null })).ready).toBe(true);
    setDraining(true);
    expect((await checkReadiness(good)).ready).toBe(false);
    setDraining(false);
    // the response never carries connection details
    expect(JSON.stringify(await checkReadiness({ ...good, db: async () => ({ ok: false, error: 'conn refused to 10.0.0.5' }) }))).not.toContain('10.0.0.5');
  });
});
