/**
 * Applies the versioned migrations in ./drizzle.
 *
 *   bun migrate.ts              apply pending migrations (fails loudly)
 *   bun migrate.ts --baseline   mark every migration in the journal as already applied.
 *                               Use ONCE on a database that was created with `drizzle-kit push`
 *                               (development databases): the tables already exist, so the
 *                               baseline migration must not run again.
 *
 * Never swallow errors here: deploy.sh and CI rely on the exit code.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import { join } from 'node:path';

const connectionString = process.env.DATABASE_URL || 'postgresql://veqsio:veqsio@localhost:5460/veqsio';
const migrationsFolder = join(import.meta.dir, 'drizzle');
const baseline = process.argv.includes('--baseline');

const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

async function tableExists(schema: string, table: string): Promise<boolean> {
  const rows = await sql`select 1 from information_schema.tables where table_schema = ${schema} and table_name = ${table} limit 1`;
  return rows.length > 0;
}

async function run() {
  const hasAppTables = await tableExists('public', 'users');
  const hasLedger = await tableExists('drizzle', '__drizzle_migrations');
  const applied = hasLedger ? Number((await sql`select count(*)::int as n from drizzle.__drizzle_migrations`)[0].n) : 0;

  if (baseline) {
    if (!hasAppTables) throw new Error('--baseline is for databases that already have the application tables. Run without it on an empty database.');
    if (applied > 0) { console.log(`Ledger already has ${applied} migration(s); nothing to baseline.`); return; }
    await sql`create schema if not exists drizzle`;
    await sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
    const files = readMigrationFiles({ migrationsFolder });
    for (const m of files) {
      await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
    }
    console.log(`Baselined: marked ${files.length} migration(s) as applied.`);
    return;
  }

  if (hasAppTables && applied === 0) {
    throw new Error(
      'This database has application tables but no migration history (it was created with `drizzle-kit push`).\n' +
      'Back it up, then run `bun migrate.ts --baseline` once to adopt it, and re-run the migration.',
    );
  }

  console.log('Running migrations...');
  await migrate(drizzle(sql), { migrationsFolder });
  console.log('Migrations complete.');
}

run()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error('Migration failed:', e instanceof Error ? e.message : e);
    await sql.end({ timeout: 1 }).catch(() => {});
    process.exit(1);
  });
