import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, count, ilike, or, asc, inArray, sql } from 'drizzle-orm';
import { parseOrderBy, orderByClauses } from '../lib/order-by';
import type { AppContext } from '../auth/middleware';

const app = new Hono<AppContext>();
app.use('/rest/api/2/group*', sessionMiddleware);

/* ------------------------------------------------------------------ */
/*  Groups CRUD                                                         */
/* ------------------------------------------------------------------ */

// Paged and searchable: ?startAt=0&maxResults=50&query=text. Without maxResults the list is capped at LEGACY_LIMIT
// (pickers that still load every group); total and isLast always tell the truth, so a caller can see truncation.
const LEGACY_LIMIT = 1000;
const MAX_PAGE = 200;
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

app.get('/rest/api/2/group', requireAuth, requireGlobalPermission('BROWSE_USERS'), async (c) => {
  const startAt = Math.max(0, Number(c.req.query('startAt')) || 0);
  const asked = Number(c.req.query('maxResults'));
  const maxResults = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_PAGE) : LEGACY_LIMIT;
  const query = (c.req.query('query') || '').trim().slice(0, 100);
  const where = query ? ilike(schema.groups.name, likePattern(query)) : undefined;

  const [{ total }] = await db.select({ total: count() }).from(schema.groups).where(where);
  const groups = await db.select().from(schema.groups).where(where).orderBy(...orderByClauses(
    parseOrderBy(c.req.query('orderBy'), ['name', 'description', 'members']),
    {
      name: schema.groups.name,
      description: schema.groups.description,
      members: sql`(SELECT count(*) FROM user_groups ug WHERE ug.group_id = ${schema.groups.id})`,
    },
    [asc(schema.groups.name)],
  )).limit(maxResults).offset(startAt);

  // one grouped query instead of one count per group
  const counts = groups.length
    ? await db
        .select({ groupId: schema.userGroups.groupId, n: count() })
        .from(schema.userGroups)
        .where(inArray(schema.userGroups.groupId, groups.map((g) => g.id)))
        .groupBy(schema.userGroups.groupId)
    : [];
  const byGroup = new Map(counts.map((r) => [r.groupId, Number(r.n)]));

  return c.json({
    startAt,
    maxResults,
    total: Number(total),
    isLast: startAt + groups.length >= Number(total),
    values: groups.map((g) => ({
      name: g.name,
      html: g.name,
      id: String(g.id),
      description: g.description,
      memberCount: byGroup.get(g.id) ?? 0,
    })),
  });
});

const createGroupSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
});

app.post('/rest/api/2/group', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', createGroupSchema), async (c) => {
  const body = c.req.valid('json');
  const [group] = await db.insert(schema.groups).values({ name: body.name, description: body.description }).returning();
  return c.json({ id: String(group.id), name: group.name, description: group.description, memberCount: 0 }, 201);
});

app.delete('/rest/api/2/group', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const groupName = c.req.query('groupname');
  if (!groupName) return c.json({ errorMessages: ['Group name required'] }, 400);

  const groups = await db.select().from(schema.groups).where(eq(schema.groups.name, groupName)).limit(1);
  if (groups.length === 0) return c.json({ errorMessages: ['Group not found'] }, 404);

  await db.delete(schema.groups).where(eq(schema.groups.id, groups[0].id));
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Group Members                                                       */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/group/member', requireAuth, requireGlobalPermission('BROWSE_USERS'), async (c) => {
  const groupName = c.req.query('groupname');
  if (!groupName) return c.json({ errorMessages: ['Group name required'] }, 400);

  const group = await db.select().from(schema.groups).where(eq(schema.groups.name, groupName)).limit(1);
  if (group.length === 0) return c.json({ errorMessages: ['Group not found'] }, 404);

  const startAt = Math.max(0, Number(c.req.query('startAt')) || 0);
  const asked = Number(c.req.query('maxResults'));
  const maxResults = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_PAGE) : 50;
  const query = (c.req.query('query') || '').trim().slice(0, 100);
  const pattern = query ? likePattern(query) : null;
  const where = and(
    eq(schema.userGroups.groupId, group[0].id),
    pattern ? or(ilike(schema.users.displayName, pattern), ilike(schema.users.username, pattern), ilike(schema.users.email, pattern)) : undefined,
  );

  const [{ total }] = await db
    .select({ total: count() })
    .from(schema.userGroups)
    .innerJoin(schema.users, eq(schema.users.id, schema.userGroups.userId))
    .where(where);
  const members = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      email: schema.users.email,
    })
    .from(schema.userGroups)
    .innerJoin(schema.users, eq(schema.users.id, schema.userGroups.userId))
    .where(where)
    .orderBy(asc(schema.users.displayName), asc(schema.users.id))
    .limit(maxResults)
    .offset(startAt);

  return c.json({
    startAt,
    maxResults,
    total: Number(total),
    isLast: startAt + members.length >= Number(total),
    values: members,
  });
});

app.post('/rest/api/2/group/user', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const groupName = c.req.query('groupname');
  const username = c.req.query('username');
  if (!groupName || !username) {
    return c.json({ errorMessages: ['groupname and username are required'] }, 400);
  }

  const group = await db.select().from(schema.groups).where(eq(schema.groups.name, groupName)).limit(1);
  if (group.length === 0) return c.json({ errorMessages: ['Group not found'] }, 404);

  const user = await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
  if (user.length === 0) return c.json({ errorMessages: ['User not found'] }, 404);

  const existing = await db
    .select()
    .from(schema.userGroups)
    .where(and(eq(schema.userGroups.userId, user[0].id), eq(schema.userGroups.groupId, group[0].id)))
    .limit(1);

  if (existing.length > 0) return c.json({ errorMessages: ['User is already a member'] }, 409);

  await db.insert(schema.userGroups).values({ userId: user[0].id, groupId: group[0].id });
  return c.json({});
});

app.delete('/rest/api/2/group/user', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const groupName = c.req.query('groupname');
  const username = c.req.query('username');
  if (!groupName || !username) {
    return c.json({ errorMessages: ['groupname and username are required'] }, 400);
  }

  const group = await db.select().from(schema.groups).where(eq(schema.groups.name, groupName)).limit(1);
  if (group.length === 0) return c.json({ errorMessages: ['Group not found'] }, 404);

  const user = await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
  if (user.length === 0) return c.json({ errorMessages: ['User not found'] }, 404);

  await db
    .delete(schema.userGroups)
    .where(and(eq(schema.userGroups.userId, user[0].id), eq(schema.userGroups.groupId, group[0].id)));
  return c.json({});
});

export default app;
