import { db } from '../db';
import * as schema from '@veqsio/db';
import { sql, isNotNull } from 'drizzle-orm';
import { checkGlobalPermission, entryGrantsSql } from '../middleware/permissions';

type User = typeof schema.users.$inferSelect;

export async function isAdminUser(user: User): Promise<boolean> {
  return user.username === 'admin' || (await checkGlobalPermission(user, 'ADMINISTER'));
}

/**
 * Ids of the projects the user may browse (BROWSE_PROJECTS), via the permission scheme of each project.
 * Used to trim search results, digests and autocomplete suggestions so that nothing from projects the
 * caller cannot see is leaked.
 */
export async function getBrowsableProjectIds(user: User): Promise<number[]> {
  if (await isAdminUser(user)) {
    return (await db.select({ id: schema.projects.id }).from(schema.projects)).map((r) => r.id);
  }
  // One set-based query for every project instead of a permission check (up to nine queries) per project.
  const rows = (await db.execute(sql`
    SELECT p.id, a.scheme_id
    FROM projects p
    LEFT JOIN permission_scheme_associations a ON a.project_id = p.id
    WHERE a.scheme_id IS NULL OR EXISTS (
      SELECT 1 FROM permission_entries e
      WHERE e.scheme_id = a.scheme_id AND e.permission_key = 'BROWSE_PROJECTS'
        AND ${entryGrantsSql(user.id, sql`p.id`)})
  `)) as unknown as Array<{ id: number; scheme_id: number | null }>;
  const noScheme = rows.filter((r) => r.scheme_id === null);
  // Projects without a scheme fall back to the global permission (same rule as checkProjectPermission).
  const globalOk = noScheme.length > 0 && (await checkGlobalPermission(user, 'BROWSE_PROJECTS'));
  return rows.filter((r) => r.scheme_id !== null || globalOk).map((r) => r.id);
}

/**
 * Browsable projects minus archived ones, for default searches and lists. An archived project stays searchable when the
 * caller asks for it (`includeArchived`) or names its key in the JQL (`project = OLD`), so direct links and deliberate
 * queries keep working while it no longer clutters everyday results.
 */
export async function getSearchableProjectIds(user: User, jql: string, includeArchived = false): Promise<number[]> {
  const browsable = await getBrowsableProjectIds(user);
  if (includeArchived || !browsable.length) return browsable;
  const archived = await db.select({ id: schema.projects.id, key: schema.projects.projectKey }).from(schema.projects).where(isNotNull(schema.projects.archivedAt));
  if (!archived.length) return browsable;
  const upper = jql.toUpperCase();
  const hidden = new Set(archived.filter((p) => !new RegExp(`(^|[^A-Z0-9_])${p.key.replace(/[^A-Z0-9]/g, '')}([^A-Z0-9_]|$)`).test(upper)).map((p) => p.id));
  return browsable.filter((id) => !hidden.has(id));
}
