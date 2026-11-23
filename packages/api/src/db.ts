import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@veqsio/db';
import { requestContext } from './ops/logger';

const connectionString = process.env.DATABASE_URL || 'postgresql://veqsio:veqsio@localhost:5460/veqsio';
const poolMax = Number(process.env.DB_POOL_MAX) || 10;
const idleTimeout = Number(process.env.DB_IDLE_TIMEOUT) || 30;
const connectTimeout = Number(process.env.DB_CONNECT_TIMEOUT) || 10;
const client = postgres(connectionString, { max: poolMax, idle_timeout: idleTimeout, connect_timeout: connectTimeout });
// Background jobs hold one connection for the whole run (the transaction that owns their advisory lock). That connection must
// not come from `client`: job.run() needs a second one from it, so enough jobs starting together (all timers tick on the same
// second) would take the whole pool and then wait on each other forever, starving every request too. Connections here are only
// ever held by running jobs and nothing else waits on them, so this pool cannot deadlock however small it is.
const jobLockPoolMax = Number(process.env.DB_JOB_LOCK_POOL_MAX) || 16;
const jobLockClient = postgres(connectionString, { max: jobLockPoolMax, idle_timeout: idleTimeout, connect_timeout: connectTimeout });
// Counts the queries of the current request (shown on its trace span as db.query.count); the statement text is never recorded.
export const db = drizzle(client, { schema, logger: { logQuery() { const s = requestContext.getStore(); if (s) s.dbQueries = (s.dbQueries ?? 0) + 1; } } });
export { client, jobLockClient };

export function configureConnectionPool(): void {
  console.info(`[DB] Connection pool configured: max=${poolMax}, job_lock_max=${jobLockPoolMax}, idle_timeout=${idleTimeout}s, connect_timeout=${connectTimeout}s`);
}
