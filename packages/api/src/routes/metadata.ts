import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import * as schema from '@veqsio/db';
import { eq, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireGlobalPermission } from '../rbac/middleware';
import { cacheMiddleware } from '../middleware/cache';
import type { AppContext } from '../auth/middleware';

import { db } from '../db';

const app = new Hono<AppContext>();
app.use('/rest/api/2/issuetype*', sessionMiddleware);
app.use('/rest/api/2/status*', sessionMiddleware);
app.use('/rest/api/2/priority*', sessionMiddleware);
app.use('/rest/api/2/resolution*', sessionMiddleware);
app.use('/rest/api/2/field', sessionMiddleware);
app.use('/rest/api/2/issueLinkType', sessionMiddleware);

app.get('/rest/api/2/issueLinkType', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ errorMessages: ['Authentication required'] }, 401);
  const types = await db.select().from(schema.linkTypes).orderBy(asc(schema.linkTypes.id));
  return c.json({
    issueLinkTypes: types.map((t) => ({ id: String(t.id), name: t.name, inward: t.inward, outward: t.outward, scheduling: t.scheduling, isSystem: t.isSystem })),
  });
});

/* Administrators define their own link types (built-in ones cannot be changed or deleted). */
const linkTypeBody = z.object({
  name: z.string().trim().min(1).max(100),
  inward: z.string().trim().min(1).max(100),
  outward: z.string().trim().min(1).max(100),
}).strict();
const admin = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const;
const errors = (c: any, e: z.ZodError) => c.json({ errorMessages: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) }, 400);
const nameTaken = async (name: string, exceptId?: number) => {
  const rows = await db.select({ id: schema.linkTypes.id }).from(schema.linkTypes).where(sql`lower(${schema.linkTypes.name}) = ${name.toLowerCase()}`);
  return rows.some((r) => r.id !== exceptId);
};
const serialize = (t: typeof schema.linkTypes.$inferSelect, links = 0) => ({ id: String(t.id), name: t.name, inward: t.inward, outward: t.outward, scheduling: t.scheduling, isSystem: t.isSystem, linkCount: links });

app.get('/rest/api/2/admin/linktype', ...admin, async (c) => {
  const types = await db.select().from(schema.linkTypes).orderBy(asc(schema.linkTypes.id));
  const counts = await db.select({ id: schema.issueLinks.linkTypeId, n: sql<number>`count(*)::int` }).from(schema.issueLinks).groupBy(schema.issueLinks.linkTypeId);
  const byType = new Map(counts.map((r) => [r.id, r.n]));
  return c.json({ issueLinkTypes: types.map((t) => serialize(t, byType.get(t.id) ?? 0)) });
});

app.post('/rest/api/2/admin/linktype', ...admin, async (c) => {
  const parsed = linkTypeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return errors(c, parsed.error);
  if (await nameTaken(parsed.data.name)) return c.json({ errorMessages: [`A link type named "${parsed.data.name}" already exists`] }, 409);
  const [t] = await db.insert(schema.linkTypes).values({ ...parsed.data, isSystem: false }).returning();
  return c.json(serialize(t), 201);
});

app.put('/rest/api/2/admin/linktype/:typeId', ...admin, async (c) => {
  const id = Number(c.req.param('typeId'));
  const parsed = linkTypeBody.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return errors(c, parsed.error);
  const [cur] = await db.select().from(schema.linkTypes).where(eq(schema.linkTypes.id, id)).limit(1);
  if (!cur) return c.json({ errorMessages: ['Link type not found'] }, 404);
  if (cur.isSystem) return c.json({ errorMessages: [`"${cur.name}" is a built-in link type and cannot be changed`] }, 409);
  if (parsed.data.name && (await nameTaken(parsed.data.name, id))) return c.json({ errorMessages: [`A link type named "${parsed.data.name}" already exists`] }, 409);
  if (Object.keys(parsed.data).length) await db.update(schema.linkTypes).set(parsed.data).where(eq(schema.linkTypes.id, id));
  const [t] = await db.select().from(schema.linkTypes).where(eq(schema.linkTypes.id, id)).limit(1);
  return c.json(serialize(t));
});

app.delete('/rest/api/2/admin/linktype/:typeId', ...admin, async (c) => {
  const id = Number(c.req.param('typeId'));
  const [cur] = await db.select().from(schema.linkTypes).where(eq(schema.linkTypes.id, id)).limit(1);
  if (!cur) return c.json({ errorMessages: ['Link type not found'] }, 404);
  if (cur.isSystem) return c.json({ errorMessages: [`"${cur.name}" is a built-in link type and cannot be deleted`] }, 409);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.issueLinks).where(eq(schema.issueLinks.linkTypeId, id));
  if (n > 0) return c.json({ errorMessages: [`"${cur.name}" is used by ${n} link${n === 1 ? '' : 's'}. Remove those links first.`], linkCount: n }, 409);
  await db.delete(schema.linkTypes).where(eq(schema.linkTypes.id, id));
  return c.json({});
});

app.get('/rest/api/2/issuetype', requireAuth, cacheMiddleware(1800), async (c) => {
  const types = await db.select().from(schema.issueTypes).orderBy(asc(schema.issueTypes.id));
  return c.json(types.map(t => ({
    id: String(t.id),
    name: t.name,
    description: t.description,
    iconUrl: t.iconUrl,
    subtask: t.isSubtask,
    avatarId: null,
  })));
});

app.get('/rest/api/2/status', requireAuth, cacheMiddleware(1800), async (c) => {
  const statuses = await db.select().from(schema.statuses).orderBy(asc(schema.statuses.sortOrder));
  return c.json(statuses.map(s => ({
    id: String(s.id),
    name: s.name,
    description: s.description,
    statusCategory: { id: s.id, key: s.category, colorName: s.color },
  })));
});

app.get('/rest/api/2/priority', requireAuth, cacheMiddleware(1800), async (c) => {
  const priorities = await db.select().from(schema.priorities).orderBy(asc(schema.priorities.sortOrder));
  return c.json(priorities.map(p => ({
    id: String(p.id),
    name: p.name,
    description: p.description,
    iconUrl: p.iconUrl,
    statusColor: p.color,
  })));
});

app.get('/rest/api/2/resolution', requireAuth, cacheMiddleware(1800), async (c) => {
  const resolutions = await db.select().from(schema.resolutions);
  return c.json(resolutions.map(r => ({
    id: String(r.id),
    name: r.name,
    description: r.description,
  })));
});

app.get('/rest/api/2/field', requireAuth, cacheMiddleware(1800), async (c) => {
  // System fields + custom fields
  const systemFields = [
    { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string', system: 'summary' } },
    { id: 'description', name: 'Description', custom: false, schema: { type: 'string', system: 'description' } },
    { id: 'status', name: 'Status', custom: false, schema: { type: 'status', system: 'status' } },
    { id: 'issuetype', name: 'Issue Type', custom: false, schema: { type: 'issuetype', system: 'issuetype' } },
    { id: 'priority', name: 'Priority', custom: false, schema: { type: 'priority', system: 'priority' } },
    { id: 'assignee', name: 'Assignee', custom: false, schema: { type: 'user', system: 'assignee' } },
    { id: 'reporter', name: 'Reporter', custom: false, schema: { type: 'user', system: 'reporter' } },
    { id: 'labels', name: 'Labels', custom: false, schema: { type: 'array', items: 'string', system: 'labels' } },
    { id: 'created', name: 'Created', custom: false, schema: { type: 'datetime', system: 'created' } },
    { id: 'updated', name: 'Updated', custom: false, schema: { type: 'datetime', system: 'updated' } },
  ];

  const custom = await db.select().from(schema.customFields);
  const customFields = custom.map(cf => ({
    id: `customfield_${cf.id}`,
    name: cf.name,
    custom: true,
    schema: { type: cf.fieldType, customId: cf.id, custom: cf.fieldType },
  }));

  return c.json([...systemFields, ...customFields]);
});

export default app;
