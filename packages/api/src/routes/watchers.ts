import { Hono } from 'hono';
import { requireIssueAccess } from '../middleware/permissions';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import * as schema from '@veqsio/db';
import { eq, and, count } from 'drizzle-orm';
import { getIssue } from '../issues/service';
import type { AppContext } from '../auth/middleware';

import { db } from '../db';

const app = new Hono<AppContext>();
app.use('/rest/api/2/issue/*/watchers', sessionMiddleware);

app.get('/rest/api/2/issue/:idOrKey/watchers', requireAuth, requireIssueAccess(), async (c) => {
  try {
    const idOrKey = c.req.param('idOrKey');
    const user = c.get('user')!;
    const issue = await getIssue(idOrKey);
    if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

    const watchers = await db
      .select({ id: schema.users.id, displayName: schema.users.displayName })
      .from(schema.watchers)
      .innerJoin(schema.users, eq(schema.users.id, schema.watchers.userId))
      .where(eq(schema.watchers.issueId, issue.id));

    const isWatching = watchers.some(w => w.id === user.id);

    return c.json({
      watchCount: watchers.length,
      isWatching,
      watchers: watchers.map(w => ({ id: w.id, displayName: w.displayName })),
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to fetch watchers'] }, 500);
  }
});

app.post('/rest/api/2/issue/:idOrKey/watchers', requireAuth, requireIssueAccess(), async (c) => {
  try {
    const idOrKey = c.req.param('idOrKey');
    const user = c.get('user')!;
    const issue = await getIssue(idOrKey);
    if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

    await db.insert(schema.watchers)
      .values({ issueId: issue.id, userId: user.id })
      .onConflictDoNothing();

    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to watch issue'] }, 500);
  }
});

app.delete('/rest/api/2/issue/:idOrKey/watchers', requireAuth, requireIssueAccess(), async (c) => {
  try {
    const idOrKey = c.req.param('idOrKey');
    const user = c.get('user')!;
    const issue = await getIssue(idOrKey);
    if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

    await db.delete(schema.watchers)
      .where(and(eq(schema.watchers.issueId, issue.id), eq(schema.watchers.userId, user.id)));

    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to unwatch issue'] }, 500);
  }
});

export default app;
