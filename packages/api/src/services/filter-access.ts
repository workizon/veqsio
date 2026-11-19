import { z } from 'zod';
import { and, eq, inArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { getBrowsableProjectIds, isAdminUser } from './browse';

type User = typeof schema.users.$inferSelect;
type FilterRow = typeof schema.filters.$inferSelect;

/**
 * Share model: array of { type: 'user'|'group'|'project'|'global', id? }.
 *  - user:    visible to that user
 *  - group:   visible to members of that group
 *  - project: visible to users who can BROWSE_PROJECTS in that project
 *  - global:  visible to every authenticated user
 * The owner and administrators always see the filter.
 */
export const shareSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z.object({ type: z.literal('user'), id: z.number().int().positive().max(2_000_000_000) }).strict(),
  z.object({ type: z.literal('group'), id: z.number().int().positive().max(2_000_000_000) }).strict(),
  z.object({ type: z.literal('project'), id: z.number().int().positive().max(2_000_000_000) }).strict(),
]);
export const sharesSchema = z.array(shareSchema).max(100);
export type Share = z.infer<typeof shareSchema>;

/** Read shares from a jsonb value written by older code (could be anything). Invalid entries are dropped. */
export function normalizeShares(raw: unknown): Share[] {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  const out: Share[] = [];
  for (const e of v) {
    const r = shareSchema.safeParse(e);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** De-duplicate shares (same type+id). */
export function dedupeShares(shares: Share[]): Share[] {
  const seen = new Set<string>();
  return shares.filter((s) => {
    const k = `${s.type}:${'id' in s ? s.id : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const intArray = (ids: number[]): SQL =>
  ids.length ? sql`ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::int[]` : sql`ARRAY[]::int[]`;

/**
 * SQL predicate: does the user see a row with this shares column and owner column? (owner, or a matching share).
 * Administrators are handled by callers. Used by saved filters and saved views.
 */
export async function sharedVisibleSql(user: User, sharesCol: SQL | AnyColumn, ownerCol: SQL | AnyColumn): Promise<SQL> {
  const groupRows = await db.select({ g: schema.userGroups.groupId }).from(schema.userGroups)
    .where(eq(schema.userGroups.userId, user.id));
  const projectIds = await getBrowsableProjectIds(user);
  const groups = intArray(groupRows.map((r) => r.g));
  const projects = intArray(projectIds);
  const shareMatch = sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${sharesCol}) = 'array' THEN ${sharesCol} ELSE '[]'::jsonb END) e
    WHERE e->>'type' = 'global'
      OR (e->>'type' = 'user' AND CASE WHEN (e->>'id') ~ '^[0-9]{1,9}$' THEN (e->>'id')::int END = ${user.id})
      OR (e->>'type' = 'group' AND CASE WHEN (e->>'id') ~ '^[0-9]{1,9}$' THEN (e->>'id')::int END = ANY(${groups}))
      OR (e->>'type' = 'project' AND CASE WHEN (e->>'id') ~ '^[0-9]{1,9}$' THEN (e->>'id')::int END = ANY(${projects}))
  )`;
  return or(eq(ownerCol as any, user.id), shareMatch)!;
}

/** SQL predicate: does the user see this filter row? */
export async function visibleToUserSql(user: User): Promise<SQL> {
  return sharedVisibleSql(user, schema.filters.shares, schema.filters.authorId);
}

/** Shares may only point at things the sharer can legitimately reference. Returns an error message or null. */
export async function checkShareTargets(user: User, shares: Share[]): Promise<string | null> {
  const admin = await isAdminUser(user);
  const userIds = shares.filter((s) => s.type === 'user').map((s) => (s as any).id as number);
  const groupIds = shares.filter((s) => s.type === 'group').map((s) => (s as any).id as number);
  const projectIds = shares.filter((s) => s.type === 'project').map((s) => (s as any).id as number);
  if (userIds.length) {
    const rows = await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(inArray(schema.users.id, userIds), eq(schema.users.active, true)));
    if (rows.length !== new Set(userIds).size) return 'Invalid share target';
  }
  if (groupIds.length) {
    const rows = await db.select({ id: schema.groups.id }).from(schema.groups).where(inArray(schema.groups.id, groupIds));
    if (rows.length !== new Set(groupIds).size) return 'Invalid share target';
    if (!admin) {
      const mine = await db.select({ g: schema.userGroups.groupId }).from(schema.userGroups)
        .where(and(eq(schema.userGroups.userId, user.id), inArray(schema.userGroups.groupId, groupIds)));
      if (mine.length !== new Set(groupIds).size) return 'Invalid share target';
    }
  }
  if (projectIds.length) {
    const browsable = new Set(await getBrowsableProjectIds(user));
    if (!projectIds.every((id) => browsable.has(id))) return 'Invalid share target';
  }
  return null;
}

/** Load a filter only if the caller may see it; otherwise null (callers answer 404). */
export async function getVisibleFilter(user: User, id: number): Promise<{ filter: FilterRow; isOwner: boolean; isAdmin: boolean } | null> {
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) return null;
  const admin = await isAdminUser(user);
  const where = admin ? eq(schema.filters.id, id) : and(eq(schema.filters.id, id), await visibleToUserSql(user))!;
  const [filter] = await db.select().from(schema.filters).where(where).limit(1);
  if (!filter) return null;
  return { filter, isOwner: filter.authorId === user.id, isAdmin: admin };
}

export function canManageFilter(access: { isOwner: boolean; isAdmin: boolean }): boolean {
  return access.isOwner || access.isAdmin;
}
