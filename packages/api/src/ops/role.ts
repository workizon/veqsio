/**
 * Process role (env VEQSIO_ROLE), for running several API replicas:
 *
 *   all     (default) serve HTTP/WebSocket AND run the background jobs. Right for a single node.
 *   web     serve HTTP/WebSocket only; no timers. Put these behind the load balancer.
 *   worker  run the background jobs; still listens on PORT for /health, /ready and /metrics but must not receive
 *           user traffic. Run exactly one (or several: the advisory locks make extra workers harmless).
 *
 * Even with role `all` on every node the jobs are safe: each run takes a PostgreSQL advisory lock (see jobs.ts).
 */
export type Role = 'all' | 'web' | 'worker';

export function processRole(env: Record<string, string | undefined> = process.env): Role {
  const v = (env.VEQSIO_ROLE || 'all').trim().toLowerCase();
  if (v === 'web' || v === 'worker' || v === 'all') return v;
  throw new Error(`Invalid VEQSIO_ROLE "${env.VEQSIO_ROLE}": use all, web or worker`);
}
export const runsJobs = (env: Record<string, string | undefined> = process.env) => processRole(env) !== 'web';
export const servesTraffic = (env: Record<string, string | undefined> = process.env) => processRole(env) !== 'worker';
