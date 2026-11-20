import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';

const app = new Hono<AppContext>();
const P = '/rest/api/2/inbox';
const KEEP_DAYS = 90;
const T = schema.inboxNotifications;

/** The signed-in user's own notifications, newest first, plus the unread count. */
app.get(P, requireAuth, async (c) => {
  const user = c.get('user')!;
  // Housekeeping on the way: the inbox is a short-lived feed, not an archive.
  await db.delete(T).where(and(eq(T.userId, user.id), lt(T.createdAt, new Date(Date.now() - KEEP_DAYS * 86400_000))));
  const items = await db.select().from(T).where(eq(T.userId, user.id)).orderBy(desc(T.createdAt), desc(T.id)).limit(50);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(T).where(and(eq(T.userId, user.id), isNull(T.readAt)));
  return c.json({
    unread: n,
    items: items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, body: i.body, link: i.link, read: i.readAt !== null, createdAt: i.createdAt })),
  });
});

/** Mark some (ids) or all (no ids) of the caller's notifications read. Other people's ids are ignored. */
app.post(`${P}/read`, requireAuth, zValidator('json', z.object({ ids: z.array(z.number().int()).max(200).optional() }).strict()), async (c) => {
  const user = c.get('user')!;
  const { ids } = c.req.valid('json');
  const where = ids ? and(eq(T.userId, user.id), isNull(T.readAt), inArray(T.id, ids)) : and(eq(T.userId, user.id), isNull(T.readAt));
  if (ids && !ids.length) return c.json({ ok: true });
  await db.update(T).set({ readAt: new Date() }).where(where);
  return c.json({ ok: true });
});

export default app;
