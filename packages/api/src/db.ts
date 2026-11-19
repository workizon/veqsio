import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@veqsio/db';
import { requestContext } from './ops/logger';

const connectionString = process.env.DATABASE_URL || 'postgresql://veqsio:veqsio@localhost:5460/veqsio';
const client = postgres(connectionString, {
  max: Number(process.env.DB_POOL_MAX) || 10,
  idle_timeout: Number(process.env.DB_IDLE_TIMEOUT) || 30,
  connect_timeout: Number(process.env.DB_CONNECT_TIMEOUT) || 10,
});
// Counts the queries of the current request (shown on its trace span as db.query.count); the statement text is never recorded.
export const db = drizzle(client, { schema, logger: { logQuery() { const s = requestContext.getStore(); if (s) s.dbQueries = (s.dbQueries ?? 0) + 1; } } });
export { client };

export function configureConnectionPool(): void {
  console.info('[DB] Connection pool configured: max=10, idle_timeout=30s, connect_timeout=10s');
}
