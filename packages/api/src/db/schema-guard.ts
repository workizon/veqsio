import { EXPECTED_MIGRATIONS, LATEST_MIGRATION } from '@veqsio/db';

export type SchemaState =
  | { ok: true; applied: number; expected: number }
  | { ok: false; reason: 'no-history' | 'outdated'; applied: number; expected: number; message: string };

/** Pure decision so it can be unit-tested without a database. */
export function evaluateSchemaState(applied: number | null, expected: number): SchemaState {
  if (applied === null || applied === 0) {
    return {
      ok: false, reason: 'no-history', applied: 0, expected,
      message: 'The database has no migration history. Run `bun migrate.ts` in packages/db (or `--baseline` once for a database created with `drizzle-kit push`).',
    };
  }
  if (applied < expected) {
    return {
      ok: false, reason: 'outdated', applied, expected,
      message: `The database schema is outdated: ${applied} of ${expected} migrations applied (latest expected: ${LATEST_MIGRATION}). Run \`bun migrate.ts\` in packages/db before starting this version.`,
    };
  }
  // applied > expected means a newer version already migrated this database; running older code is allowed to warn only.
  return { ok: true, applied, expected };
}

/** Whether the guard should refuse to start: production, or explicitly requested. Dev and tests use `drizzle-kit push`. */
export function guardEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.SKIP_SCHEMA_CHECK === '1') return false;
  return env.NODE_ENV === 'production' || env.REQUIRE_MIGRATIONS === '1';
}

/** Reads the migration ledger. Returns null when the ledger table does not exist. */
export async function readAppliedMigrations(
  query: (sql: string) => Promise<Array<Record<string, unknown>>>,
): Promise<number | null> {
  const exists = await query(
    "select 1 as x from information_schema.tables where table_schema = 'drizzle' and table_name = '__drizzle_migrations' limit 1",
  );
  if (exists.length === 0) return null;
  const rows = await query('select count(*)::int as n from drizzle.__drizzle_migrations');
  return Number(rows[0]?.n ?? 0);
}

/** Call once at startup. Throws (so the process exits) when the guard is enabled and the schema is not up to date. */
export async function assertSchemaUpToDate(
  query: (sql: string) => Promise<Array<Record<string, unknown>>>,
  env: Record<string, string | undefined> = process.env,
): Promise<SchemaState | null> {
  if (!guardEnabled(env)) return null;
  const state = evaluateSchemaState(await readAppliedMigrations(query), EXPECTED_MIGRATIONS);
  if (!state.ok) throw new Error(`[schema] ${state.message}`);
  if (state.applied > state.expected) {
    console.warn(`[schema] Database has ${state.applied} migrations but this build expects ${state.expected}; running an older build against a newer schema.`);
  }
  return state;
}
