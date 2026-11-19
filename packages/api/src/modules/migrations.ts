/**
 * Per-module migration runner.
 *
 *  - Migrations are SQL text shipped by the module (`defineModule({ migrations })`), identified by name and
 *    fingerprinted with a sha256 checksum stored in `module_migrations`.
 *  - Forward-only: applied migrations are never re-run or reverted. If an applied migration's checksum no longer
 *    matches the shipped SQL (somebody edited history) the run aborts with a drift error before touching anything.
 *  - Every migration runs in its own transaction, guarded by a Postgres advisory lock per module so two API
 *    nodes installing or updating the same module cannot interleave.
 *  - Guard rails (a lint, not a sandbox: modules are trusted code): every table, index and similar object the SQL
 *    creates or alters must be prefixed with the module id (`example-notes` -> `example_notes_`).
 */
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { moduleMigrations } from '@veqsio/db'
import { moduleTablePrefix, type ModuleMigration } from '@veqsio/sdk'
import { db as defaultDb } from '../db'

export type Db = typeof defaultDb

export class MigrationError extends Error {
  constructor(message: string, public readonly kind: 'drift' | 'orphaned' | 'lint' | 'sql', public readonly migration?: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

export function checksum(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
}

export interface LedgerRow { name: string; checksum: string }

export interface MigrationPlan {
  /** Migrations not yet applied, in order. */
  pending: ModuleMigration[]
  /** Names already applied (and verified). */
  applied: string[]
  /** Applied migrations whose shipped SQL changed. */
  drift: Array<{ name: string; recorded: string; shipped: string }>
  /** Ledger entries for migrations this build of the module does not ship (a downgrade or a removed file). */
  orphaned: string[]
}

/** Pure: compares the shipped migrations with the ledger. */
export function planMigrations(files: ModuleMigration[], ledger: LedgerRow[]): MigrationPlan {
  const byName = new Map(ledger.map((l) => [l.name, l.checksum]))
  const shipped = new Set(files.map((f) => f.name))
  const plan: MigrationPlan = { pending: [], applied: [], drift: [], orphaned: [] }
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const recorded = byName.get(f.name)
    if (recorded === undefined) plan.pending.push(f)
    else if (recorded !== checksum(f.sql)) plan.drift.push({ name: f.name, recorded, shipped: checksum(f.sql) })
    else plan.applied.push(f.name)
  }
  plan.orphaned = ledger.map((l) => l.name).filter((n) => !shipped.has(n)).sort()
  // A pending migration older than an applied one means history was rewritten: treat as drift of ordering.
  const lastApplied = plan.applied[plan.applied.length - 1]
  if (lastApplied) {
    for (const p of plan.pending) {
      if (p.name < lastApplied) plan.drift.push({ name: p.name, recorded: '(missing)', shipped: checksum(p.sql) })
    }
  }
  return plan
}

/* ------------------------------------------------------------------ */
/*  SQL guard rails                                                    */
/* ------------------------------------------------------------------ */

function stripSql(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

const unquote = (s: string) => s.trim().replace(/^"|"$/g, '').replace(/""/g, '"')

/** Splits `schema.name` and returns [schema|null, name]. */
function qualified(raw: string): [string | null, string] {
  const parts = raw.trim().split('.').map(unquote)
  return parts.length === 2 ? [parts[0], parts[1]] : [null, parts[0]]
}

/** Returns a list of human readable violations; empty when the SQL is acceptable for the module. */
export function lintMigrationSql(moduleId: string, text: string): string[] {
  const prefix = moduleTablePrefix(moduleId)
  const s = stripSql(text)
  const out: string[] = []
  const own = (raw: string, what: string) => {
    const [schema, name] = qualified(raw)
    if (schema && schema.toLowerCase() !== 'public') out.push(`${what} "${raw.trim()}" must live in the public schema`)
    else if (!name.startsWith(prefix)) out.push(`${what} "${name}" must start with "${prefix}"`)
  }

  const forbidden: Array<[RegExp, string]> = [
    [/\b(?:create|drop|alter)\s+(?:schema|database|role|user|extension|tablespace)\b/i, 'schema, database, role and extension changes are not allowed in module migrations'],
    [/\b(?:grant|revoke)\b/i, 'GRANT and REVOKE are not allowed in module migrations'],
    [/\bset\s+(?:local\s+|session\s+)?search_path\b/i, 'changing search_path is not allowed'],
    [/\b(?:drizzle|pg_catalog|information_schema)\s*\./i, 'touching system or migration schemas is not allowed'],
    [/\b(?:installed_modules|module_migrations)\b/i, 'module bookkeeping tables are off limits'],
    [/\btruncate\b/i, 'TRUNCATE is not allowed in module migrations'],
  ]
  for (const [re, msg] of forbidden) if (re.test(s)) out.push(msg)

  for (const m of s.matchAll(/\bcreate\s+(?:unlogged\s+|temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?("[^"]+"|[\w.]+)/gi)) own(m[1], 'table')
  for (const m of s.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?("[^"]+"|[\w.]+)/gi)) own(m[1], 'table')
  for (const m of s.matchAll(/\bdrop\s+table\s+(?:if\s+exists\s+)?([^;]+)/gi)) {
    for (const t of m[1].replace(/\b(?:cascade|restrict)\b/gi, '').split(',')) if (t.trim()) own(t, 'table')
  }
  for (const m of s.matchAll(/\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?("[^"]+"|[\w.]+)?\s*on\s+(?:only\s+)?("[^"]+"|[\w.]+)/gi)) {
    if (m[1] && !/^on$/i.test(m[1])) own(m[1], 'index')
    own(m[2], 'table')
  }
  for (const m of s.matchAll(/\bdrop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?("[^"]+"|[\w.]+)/gi)) own(m[1], 'index')
  for (const m of s.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+view|view|sequence|type|function|trigger)\s+(?:if\s+not\s+exists\s+)?("[^"]+"|[\w.]+)/gi)) own(m[1], 'object')
  for (const m of s.matchAll(/\binsert\s+into\s+("[^"]+"|[\w.]+)/gi)) own(m[1], 'table')
  for (const m of s.matchAll(/\bupdate\s+(?:only\s+)?("[^"]+"|[\w.]+)\s+set\b/gi)) own(m[1], 'table')
  for (const m of s.matchAll(/\bdelete\s+from\s+(?:only\s+)?("[^"]+"|[\w.]+)/gi)) own(m[1], 'table')
  return [...new Set(out)]
}

/* ------------------------------------------------------------------ */
/*  Runner                                                             */
/* ------------------------------------------------------------------ */

export async function readLedger(db: Db, moduleId: string): Promise<LedgerRow[]> {
  const rows = await db.select().from(moduleMigrations).where(eq(moduleMigrations.moduleId, moduleId))
  return rows.map((r) => ({ name: r.name, checksum: r.checksum }))
}

/** Throws MigrationError for lint violations, drift or orphaned history; applies pending migrations otherwise. */
export async function runModuleMigrations(db: Db, moduleId: string, files: ModuleMigration[]): Promise<{ applied: string[]; skipped: string[] }> {
  for (const f of files) {
    const problems = lintMigrationSql(moduleId, f.sql)
    if (problems.length) throw new MigrationError(`Migration ${f.name} of module "${moduleId}" was rejected: ${problems.join('; ')}`, 'lint', f.name)
  }
  const plan = planMigrations(files, await readLedger(db, moduleId))
  if (plan.drift.length) {
    const d = plan.drift[0]
    throw new MigrationError(
      `Migration ${d.name} of module "${moduleId}" changed after it was applied (recorded ${d.recorded.slice(0, 12)}, shipped ${d.shipped.slice(0, 12)}). Migrations are forward-only: add a new migration instead of editing an applied one.`,
      'drift', d.name,
    )
  }
  if (plan.orphaned.length) {
    throw new MigrationError(
      `The database has migrations of module "${moduleId}" that this version does not ship (${plan.orphaned.join(', ')}). Refusing to run an older module version against a newer schema.`,
      'orphaned', plan.orphaned[0],
    )
  }
  const applied: string[] = []
  for (const m of plan.pending) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'veqsio.module.migrations:' + moduleId}))`)
        // Re-check under the lock: another node may have applied it while we waited.
        const [row] = await tx.select().from(moduleMigrations).where(and(eq(moduleMigrations.moduleId, moduleId), eq(moduleMigrations.name, m.name))).limit(1)
        if (row) {
          if (row.checksum !== checksum(m.sql)) throw new MigrationError(`Migration ${m.name} of module "${moduleId}" changed after it was applied`, 'drift', m.name)
          return
        }
        await tx.execute(sql.raw(m.sql))
        await tx.insert(moduleMigrations).values({ moduleId, name: m.name, checksum: checksum(m.sql) })
        applied.push(m.name)
      })
    } catch (e) {
      if (e instanceof MigrationError) throw e
      throw new MigrationError(`Migration ${m.name} of module "${moduleId}" failed: ${(e as Error).message}`, 'sql', m.name)
    }
  }
  return { applied, skipped: plan.applied }
}

/** Tables owned by a module: the prefix match minus tables that belong to a longer-prefixed sibling module. */
export function ownedTables(allTables: string[], moduleId: string, otherModuleIds: string[]): string[] {
  const prefix = moduleTablePrefix(moduleId)
  const longer = otherModuleIds.map(moduleTablePrefix).filter((p) => p !== prefix && p.startsWith(prefix))
  return allTables.filter((t) => t.startsWith(prefix) && !longer.some((p) => t.startsWith(p)))
}

const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"'

/** Drops every table the module owns and forgets its migration history. Used by uninstall with deleteData. */
export async function dropModuleData(db: Db, moduleId: string, otherModuleIds: string[]): Promise<string[]> {
  const rows = (await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)) as unknown as Array<{ table_name: string }>
  const tables = ownedTables(rows.map((r) => r.table_name), moduleId, otherModuleIds)
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'veqsio.module.migrations:' + moduleId}))`)
    for (const t of tables) await tx.execute(sql.raw(`drop table if exists ${ident(t)} cascade`))
    await tx.delete(moduleMigrations).where(eq(moduleMigrations.moduleId, moduleId))
  })
  return tables
}
