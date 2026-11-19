import { EXPECTED_MIGRATIONS } from '@veqsio/db';
import { client } from '../db';
import { redis } from '../services/cache';
import { getLicenseInfo } from '../license';
import { hub } from '../realtime/hub';
import { VERSION, buildId } from '../version';
import { countActiveUsers } from './activity';
import { processRole } from './role';
import type { ProbeSet } from './metrics';

type Rows = Array<Record<string, unknown>>;
const q = (sql: string) => client.unsafe(sql) as unknown as Promise<Rows>;

export async function pingDb(): Promise<{ ok: boolean; seconds: number; error?: string }> {
  const t = performance.now();
  try { await q('select 1 as ok'); return { ok: true, seconds: (performance.now() - t) / 1000 }; }
  catch (e) { return { ok: false, seconds: (performance.now() - t) / 1000, error: (e as Error).message }; }
}

export async function pingRedis(): Promise<{ ok: boolean; seconds: number; mode: 'redis' | 'memory'; error?: string }> {
  const mode = (process.env.REDIS_URL || '').trim() === 'memory:' ? 'memory' : 'redis';
  if (mode === 'memory') return { ok: true, seconds: 0, mode };
  const t = performance.now();
  try {
    const r = await Promise.race([
      (redis as any).ping(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
    ]);
    return { ok: r === 'PONG', seconds: (performance.now() - t) / 1000, mode };
  } catch (e) { return { ok: false, seconds: (performance.now() - t) / 1000, mode, error: (e as Error).message }; }
}

/** Number of applied migrations, or null when the ledger does not exist. */
export async function appliedMigrations(): Promise<number | null> {
  try {
    const ex = await q("select 1 as x from information_schema.tables where table_schema = 'drizzle' and table_name = '__drizzle_migrations' limit 1");
    if (!ex.length) return null;
    return Number((await q('select count(*)::int as n from drizzle.__drizzle_migrations'))[0]?.n ?? 0);
  } catch { return null; }
}

export const realProbes = (): ProbeSet => ({
  version: VERSION, build: buildId(), role: processRole(),
  async db() {
    const ping = await pingDb();
    const byState: Record<string, number> = {};
    let serverMax: number | null = null;
    if (ping.ok) {
      for (const r of await q("select coalesce(state,'background') as state, count(*)::int as n from pg_stat_activity where datname = current_database() group by 1")) byState[String(r.state)] = Number(r.n);
      serverMax = Number((await q("select setting::int as n from pg_settings where name = 'max_connections'"))[0]?.n ?? 0) || null;
    }
    return { ok: ping.ok, pingSeconds: ping.seconds, poolMax: Number(process.env.DB_POOL_MAX) || 10, byState, serverMax, migrationsApplied: ping.ok ? await appliedMigrations() : null, migrationsExpected: EXPECTED_MIGRATIONS };
  },
  async redis() { const r = await pingRedis(); return { ok: r.ok, pingSeconds: r.seconds, mode: r.mode }; },
  async queues() {
    const one = async (sql: string) => Object.fromEntries((await q(sql)).map((r) => [String(r.k), Number(r.n)]));
    const email = await one("select status as k, count(*)::int as n from email_queue where status in ('pending','failed') group by 1");
    const agents = await one("select status as k, count(*)::int as n from agent_runs where status in ('queued','delivered','running') group by 1");
    const agentFail = Number((await q("select count(*)::int as n from agent_runs where status = 'failed' and created_at > now() - interval '24 hours'"))[0]?.n ?? 0);
    const hookFail = Number((await q("select count(*)::int as n from webhook_deliveries where success = false and created_at > now() - interval '24 hours'"))[0]?.n ?? 0);
    const emailFail = Number((await q("select count(*)::int as n from email_queue where status = 'failed' and created_at > now() - interval '24 hours'"))[0]?.n ?? 0);
    const intake =Number((await q("select count(*)::int as n from intake_items where status = 'pending'"))[0]?.n ?? 0);
    const queues = [
      { queue: 'email', state: 'pending', n: email.pending ?? 0 }, { queue: 'email', state: 'failed', n: email.failed ?? 0 },
      ...['queued', 'delivered', 'running'].map((s) => ({ queue: 'agent_runs', state: s, n: agents[s] ?? 0 })),
      { queue: 'intake', state: 'pending', n: intake },
    ];
    return {
      queues,
      failures: [{ kind: 'webhook', n: hookFail }, { kind: 'agent_run', n: agentFail }, { kind: 'email', n: emailFail }],
      activeUsers: await countActiveUsers(),
    };
  },
  licence() { const l = getLicenseInfo(); return { state: l.state, plan: l.plan, expiresAt: l.expiresAt }; },
  realtimeConnections: () => hub.connectionCount(),
});
