/**
 * Background job runner: single-flight per process, cluster-wide mutual exclusion via a PostgreSQL advisory lock,
 * heartbeats for the admin health page, and Prometheus counters.
 *
 *   const job = defineJob({ name: 'email-queue', everyMs: 30_000, run: () => processEmailQueue(10) });
 *   startJobs([job]);   // honours VEQSIO_ROLE
 *
 * Exclusion: each run executes inside a transaction that first calls `pg_try_advisory_xact_lock(key)`. If another
 * node holds it the run is skipped (counted as `skipped_locked`). The lock is released when the transaction ends,
 * even if the node dies, so no lease can get stuck. Jobs that are already idempotent per slot (recurring issues,
 * IMAP leases) still go through it; the cost is one idle connection while the job runs.
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { client } from '../db';
import { redis } from '../services/cache';
import { jobLastDuration, jobLastRun, jobLastSuccess, jobRuns } from './metrics';
import { logger } from './logger';
import { runsJobs } from './role';
import { traceJob } from '../observability/tracing';

export interface JobDef<R = unknown> {
  name: string;
  everyMs: number;
  run: () => Promise<R>;
  /** Called after a successful run with the result, for the "N items" log line; return a falsy value to stay quiet. */
  describe?: (r: R) => string | null | undefined | false;
  /** Skip the advisory lock (jobs that must run on every node). */
  perNode?: boolean;
}
export const defineJob = <R>(j: JobDef<R>): JobDef<R> => j;

export const NODE_ID = `${hostname()}:${process.pid}`;
const HEARTBEAT_PREFIX = 'veqsio:ops:job:';
const HEARTBEAT_TTL_S = 7 * 24 * 3600;

export type JobResult = 'success' | 'failure' | 'skipped_locked';

export interface Heartbeat {
  job: string; node: string; everyMs: number;
  lastRunAt: string; lastSuccessAt: string | null; lastFailureAt: string | null;
  lastDurationMs: number; lastResult: JobResult; lastError: string | null;
  runs: number; failures: number;
}

/** Stable signed 64-bit key for pg_advisory_lock from a job name. */
export function lockKey(name: string): bigint {
  const h = createHash('sha256').update(`veqsio:job:${name}`).digest();
  return h.readBigInt64BE(0);
}

const local = new Map<string, Heartbeat>();
const registered = new Map<string, { name: string; everyMs: number }>();

async function writeHeartbeat(h: Heartbeat) {
  try { await redis.setex(HEARTBEAT_PREFIX + h.job, HEARTBEAT_TTL_S, JSON.stringify(h)); } catch { /* redis down: metrics still work */ }
}

/** Last heartbeat of every known job (any node: the most recent run wins), for the admin page. */
export async function readHeartbeats(names: string[] = [...registered.keys()]): Promise<Array<Heartbeat | { job: string; everyMs: number; never: true }>> {
  const out: Array<Heartbeat | { job: string; everyMs: number; never: true }> = [];
  for (const n of names) {
    let hb: Heartbeat | null = null;
    try { const raw = await redis.get(HEARTBEAT_PREFIX + n); if (raw) hb = JSON.parse(raw); } catch { /* ignore */ }
    const l = local.get(n);
    if (l && (!hb || Date.parse(l.lastRunAt) > Date.parse(hb.lastRunAt))) hb = l;
    out.push(hb ?? { job: n, everyMs: registered.get(n)?.everyMs ?? 0, never: true });
  }
  return out;
}
export type JobHealth = 'ok' | 'failing' | 'stale' | 'never';
/** failing = last run threw; stale = no run for 3 intervals (min 2 minutes); never = no heartbeat seen yet. */
export function classifyJob(h: Heartbeat | { never: true }, everyMs: number, now = Date.now()): JobHealth {
  if ('never' in h) return 'never';
  if (h.lastResult === 'failure') return 'failing';
  return now - Date.parse(h.lastRunAt) > Math.max(3 * everyMs, 120_000) ? 'stale' : 'ok';
}
export const registeredJobs =() => [...registered.values()];

/** Runs the job once now (exported for tests). Never throws. */
export async function runJobOnce<R>(job: JobDef<R>): Promise<JobResult> {
  return traceJob(job.name, () => runJobOnceUntraced(job), (r) => r);
}

async function runJobOnceUntraced<R>(job: JobDef<R>): Promise<JobResult> {
  registered.set(job.name, { name: job.name, everyMs: job.everyMs });
  const started = Date.now();
  let result = 'success' as JobResult; // assigned inside callbacks, so do not let TypeScript narrow it to 'success'
  let error: string | null = null;
  const exec = async () => {
    const r = await job.run();
    const d = job.describe?.(r);
    if (d) logger.info(d, { job: job.name });
  };
  try {
    if (job.perNode) {
      await exec();
    } else {
      await client.begin(async (tx) => {
        const [row] = await tx`select pg_try_advisory_xact_lock(${lockKey(job.name).toString()}::bigint) as ok`;
        if (!row?.ok) { result = 'skipped_locked'; return; }
        await exec();
      });
    }
  } catch (e) {
    result = 'failure'; error = e instanceof Error ? e.message : String(e);
    logger.error(`job ${job.name} failed`, { job: job.name, error: e });
  }
  const ms = Date.now() - started;
  const now = new Date().toISOString();
  const prev = local.get(job.name);
  const hb: Heartbeat = {
    job: job.name, node: NODE_ID, everyMs: job.everyMs,
    lastRunAt: now,
    lastSuccessAt: result === 'success' ? now : prev?.lastSuccessAt ?? null,
    lastFailureAt: result === 'failure' ? now : prev?.lastFailureAt ?? null,
    lastDurationMs: ms, lastResult: result, lastError: error ? error.slice(0, 300) : null,
    runs: (prev?.runs ?? 0) + (result === 'skipped_locked' ? 0 : 1),
    failures: (prev?.failures ?? 0) + (result === 'failure' ? 1 : 0),
  };
  local.set(job.name, hb);
  jobRuns.inc({ job: job.name, result });
  jobLastRun.set({ job: job.name }, Math.floor(Date.now() / 1000));
  jobLastDuration.set({ job: job.name }, ms / 1000);
  if (result === 'success') jobLastSuccess.set({ job: job.name }, Math.floor(Date.now() / 1000));
  // A skipped run did no work here and must not overwrite the heartbeat of the node that holds the lock.
  if (result !== 'skipped_locked') await writeHeartbeat(hb);
  return result;
}

const timers: Array<ReturnType<typeof setInterval>> = [];

/** Starts the interval timers (none for VEQSIO_ROLE=web). Overlapping runs inside this process are skipped. */
export function startJobs(jobs: JobDef<any>[], env: Record<string, string | undefined> = process.env): number {
  for (const j of jobs) registered.set(j.name, { name: j.name, everyMs: j.everyMs }); // known to the health page on every role
  if (!runsJobs(env)) { logger.info('background jobs disabled on this node (VEQSIO_ROLE=web)'); return 0; }
  for (const job of jobs) {
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      try { await runJobOnce(job); } finally { running = false; }
    }, job.everyMs);
    (t as { unref?: () => void }).unref?.();
    timers.push(t);
  }
  return jobs.length;
}

export function stopJobs() { for (const t of timers.splice(0)) clearInterval(t); }
