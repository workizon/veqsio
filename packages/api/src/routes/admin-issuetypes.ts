import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, count, eq, sql } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { invalidateMetadataCache } from '../middleware/cache';

/** Create, rename and delete issue types (the schemes then decide which projects offer them). SYSTEM_ADMIN only. */
const app = new Hono<AppContext>();
const P = '/rest/api/2/admin/issuetype';
const admin = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const;

const body = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).nullable().optional(),
  subtask: z.boolean().default(false),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must look like #1a2b3c').default('#0052CC'),
});

const shape = (t: typeof schema.issueTypes.$inferSelect, used = 0) => ({
  id: t.id, name: t.name, description: t.description, subtask: !!t.isSubtask, color: t.color, issueCount: used,
});

const duplicate = async (name: string, exceptId?: number) => {
  const rows = await db.select({ id: schema.issueTypes.id }).from(schema.issueTypes).where(sql`lower(${schema.issueTypes.name}) = lower(${name})`);
  return rows.some((r) => r.id !== exceptId);
};

app.get(P, ...admin, async (c) => {
  const types = await db.select().from(schema.issueTypes).orderBy(asc(schema.issueTypes.id));
  const used = await db.select({ t: schema.issues.issueTypeId, n: count() }).from(schema.issues).groupBy(schema.issues.issueTypeId);
  const m = new Map(used.map((u) => [u.t, Number(u.n)]));
  return c.json({ issueTypes: types.map((t) => shape(t, m.get(t.id) ?? 0)) });
});

app.post(P, ...admin, zValidator('json', body), async (c) => {
  const b = c.req.valid('json');
  if (await duplicate(b.name)) return c.json({ errorMessages: ['An issue type with this name already exists'] }, 409);
  const [t] = await db.insert(schema.issueTypes).values({ name: b.name, description: b.description ?? null, isSubtask: b.subtask, color: b.color }).returning();
  await invalidateMetadataCache();
  return c.json(shape(t), 201);
});

app.put(`${P}/:id`, ...admin, zValidator('json', body), async (c) => {
  const id = Number(c.req.param('id'));
  const [cur] = Number.isInteger(id) ? await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, id)).limit(1) : [];
  if (!cur) return c.json({ errorMessages: ['Issue type not found'] }, 404);
  const b = c.req.valid('json');
  if (await duplicate(b.name, id)) return c.json({ errorMessages: ['An issue type with this name already exists'] }, 409);
  const [{ n }] = await db.select({ n: count() }).from(schema.issues).where(eq(schema.issues.issueTypeId, id));
  if (!!cur.isSubtask !== b.subtask && Number(n) > 0) return c.json({ errorMessages: ['The sub-task flag cannot change while issues of this type exist'] }, 409);
  const [t] = await db.update(schema.issueTypes).set({ name: b.name, description: b.description ?? null, isSubtask: b.subtask, color: b.color }).where(eq(schema.issueTypes.id, id)).returning();
  await invalidateMetadataCache();
  return c.json(shape(t, Number(n)));
});

app.delete(P + '/:id', ...admin, async (c) => {
  const id = Number(c.req.param('id'));
  const [cur] = Number.isInteger(id) ? await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, id)).limit(1) : [];
  if (!cur) return c.json({ errorMessages: ['Issue type not found'] }, 404);
  const [{ n }] = await db.select({ n: count() }).from(schema.issues).where(eq(schema.issues.issueTypeId, id));
  if (Number(n) > 0) return c.json({ errorMessages: [`${n} issue(s) still use this type. Change their type first.`] }, 409);
  try {
    await db.delete(schema.issueTypes).where(eq(schema.issueTypes.id, id));
  } catch {
    // another table still points at it without cascade (for example a scheme default)
    return c.json({ errorMessages: ['This type is still referenced by a scheme default or another setting'] }, 409);
  }
  await invalidateMetadataCache();
  return c.body(null, 204);
});

export default app;
