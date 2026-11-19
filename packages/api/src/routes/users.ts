import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { register } from '../auth/service';
import * as schema from '@veqsio/db';
import { eq, like, count, or, ilike, asc } from 'drizzle-orm';
import { parseOrderBy, orderByClauses } from '../lib/order-by';
import type { AppContext } from '../auth/middleware';

import { db } from '../db';

const app = new Hono<AppContext>();
app.use('/rest/api/2/user*', sessionMiddleware);
app.use('/rest/api/2/group*', sessionMiddleware);
app.use('/rest/api/2/myself', sessionMiddleware);

app.get('/rest/api/2/user', requireAuth, async (c) => {
  const username = c.req.query('username');
  if (username) {
    const users = await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
    if (users.length === 0) return c.json({ errorMessages: ['User not found'] }, 404);
    const u = users[0];
    return c.json({
      self: `/rest/api/2/user?username=${u.username}`,
      key: u.username,
      name: u.displayName,
      emailAddress: u.email,
      avatarUrls: u.avatarUrl ? { '48x48': u.avatarUrl } : {},
      active: u.active,
      timeZone: u.timezone,
      id: u.id,
      isAgent: u.username.startsWith('agent:'),
    });
  }

  const startAt = Math.max(0, Number(c.req.query('startAt') || '0'));
  const maxResults = Math.min(100, Math.max(1, Number(c.req.query('maxResults') || '50')));

  const q = (c.req.query('query') || '').trim().slice(0, 100);
  const pattern = q ? `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const where = pattern ? or(ilike(schema.users.displayName, pattern), ilike(schema.users.username, pattern), ilike(schema.users.email, pattern)) : undefined;
  const allUsers = await db.select().from(schema.users).where(where).orderBy(...orderByClauses(
    parseOrderBy(c.req.query('orderBy'), ['name', 'username', 'email', 'status', 'created']),
    { name: schema.users.displayName, username: schema.users.username, email: schema.users.email, status: schema.users.active, created: schema.users.createdAt },
    [asc(schema.users.displayName), asc(schema.users.id)],
  )).limit(maxResults).offset(startAt);
  const totalResult = await db.select({ count: count() }).from(schema.users).where(where);
  const total = totalResult[0]?.count || 0;

  return c.json({
    startAt,
    maxResults,
    total,
    isLast: startAt + allUsers.length >= total,
    values: allUsers.map((u) => ({
      self: `/rest/api/2/user?username=${u.username}`,
      key: u.username,
      name: u.displayName,
      emailAddress: u.email,
      avatarUrls: u.avatarUrl ? { '48x48': u.avatarUrl } : {},
      active: u.active,
      timeZone: u.timezone,
      id: u.id,
      isAgent: u.username.startsWith('agent:'),
    })),
  });
});

app.get('/rest/api/2/user/search', requireAuth, async (c) => {
  const query = c.req.query('query') || '';
  const users = await db
    .select()
    .from(schema.users)
    .where(
      or(
        like(schema.users.username, `%${query}%`),
        like(schema.users.email, `%${query}%`),
        like(schema.users.displayName, `%${query}%`)
      )
    )
    .limit(50);

  return c.json(
    users.map((u) => ({
      self: `/rest/api/2/user?username=${u.username}`,
      key: u.username,
      name: u.displayName,
      emailAddress: u.email,
      avatarUrls: u.avatarUrl ? { '48x48': u.avatarUrl } : {},
      active: u.active,
      timeZone: u.timezone,
      id: u.id,
      isAgent: u.username.startsWith('agent:'),
    }))
  );
});

app.get('/rest/api/2/myself', requireAuth, async (c) => {
  const u = c.get('user')!;
  return c.json({
    self: `/rest/api/2/user?username=${u.username}`,
    key: u.username,
    name: u.displayName,
    emailAddress: u.email,
    avatarUrls: {},
    active: u.active,
    timeZone: u.timezone,
    id: u.id,
  });
});

// Self-service profile edit: only the caller's own record, only harmless fields (no email/active/groups/password).
const updateMyselfSchema = z.object({
  displayName: z.string().trim().min(1).max(255).optional(),
  timeZone: z.string().trim().min(1).max(100).optional(),
});

app.put('/rest/api/2/myself', requireAuth, zValidator('json', updateMyselfSchema, (r, c) => {
  if (!r.success) return c.json({ errorMessages: ['Invalid profile data: display name must be 1-255 characters'] }, 400);
}), async (c) => {
  const me = c.get('user')!;
  const body = c.req.valid('json');
  const updates: Record<string, unknown> = {};
  if (body.displayName !== undefined) updates.displayName = body.displayName;
  if (body.timeZone !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: body.timeZone }); } catch { return c.json({ errorMessages: ['Unknown time zone'] }, 400); }
    updates.timezone = body.timeZone;
  }
  if (Object.keys(updates).length === 0) return c.json({ errorMessages: ['Nothing to update'] }, 400);
  updates.updatedAt = new Date();
  await db.update(schema.users).set(updates).where(eq(schema.users.id, me.id));
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, me.id)).limit(1);
  return c.json({
    self: `/rest/api/2/user?username=${u.username}`,
    key: u.username,
    name: u.displayName,
    emailAddress: u.email,
    avatarUrls: {},
    active: u.active,
    timeZone: u.timezone,
    id: u.id,
  });
});

export default app;
