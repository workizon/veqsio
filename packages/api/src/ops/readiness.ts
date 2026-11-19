import { EXPECTED_MIGRATIONS } from '@veqsio/db';
import { evaluateSchemaState, guardEnabled } from '../db/schema-guard';
import { appliedMigrations, pingDb, pingRedis } from './probes';

/** Set by the SIGTERM handler: the node stops being "ready" so the load balancer drains it, while /health stays 200. */
let draining = false;
export const setDraining = (v = true) => { draining = v; };
export const isDraining = () => draining;

export interface ReadyCheck { name: string; ok: boolean; detail?: string }
export interface ReadyResult { ready: boolean; checks: ReadyCheck[] }

export interface ReadyDeps {
  db: () => Promise<{ ok: boolean; error?: string }>;
  redis: () => Promise<{ ok: boolean; error?: string; mode: string }>;
  migrations: () => Promise<number | null>;
  enforceMigrations: () => boolean;
}
const defaults: ReadyDeps = { db: pingDb, redis: pingRedis, migrations: appliedMigrations, enforceMigrations: () => guardEnabled() };

/**
 * Readiness: can this node serve traffic right now? Database reachable, Redis reachable (sessions, rate limits and
 * real-time fan-out live there), schema at the version this build expects, and not draining. Details are deliberately
 * coarse (no hostnames, no error strings with connection data) because the endpoint is unauthenticated.
 */
export async function checkReadiness(deps: Partial<ReadyDeps> = {}): Promise<ReadyResult> {
  const d = { ...defaults, ...deps };
  const checks: ReadyCheck[] = [];
  const db = await d.db();
  checks.push({ name: 'database', ok: db.ok, detail: db.ok ? undefined : 'unreachable' });
  const rd = await d.redis();
  checks.push({ name: 'redis', ok: rd.ok, detail: rd.ok ? undefined : 'unreachable' });
  if (!d.enforceMigrations()) {
    checks.push({ name: 'migrations', ok: true, detail: 'not enforced (development)' });
  } else if (!db.ok) {
    checks.push({ name: 'migrations', ok: false, detail: 'unknown (database unreachable)' });
  } else {
    const st = evaluateSchemaState(await d.migrations(), EXPECTED_MIGRATIONS);
    checks.push({ name: 'migrations', ok: st.ok, detail: st.ok ? undefined : st.reason });
  }
  checks.push({ name: 'draining', ok: !draining, detail: draining ? 'shutting down' : undefined });
  return { ready: checks.every((c) => c.ok), checks };
}
