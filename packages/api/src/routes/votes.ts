import { Hono } from 'hono';
import { requireIssueAccess } from '../middleware/permissions';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import * as schema from '@veqsio/db';
import { eq, and, count } from 'drizzle-orm';
import { getIssue } from '../issues/service';
import type { AppContext } from '../auth/middleware';

import { db } from '../db';

const app = new Hono<AppContext>();
app.use('/rest/api/2/issue/*/votes', sessionMiddleware);

app.get('/rest/api/2/issue/:idOrKey/votes', requireAuth, requireIssueAccess(), async (c) => {
  try {
    const idOrKey = c.req.param('idOrKey');
    const user = c.get('user')!;
    const issue = await getIssue(idOrKey);
    if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

    const voteCount = await db
      .select({ count: count() })
      .from(schema.votes)
      .where(eq(schema.votes.issueId, issue.id));

    const hasVoted = await db
      .select()
      .from(schema.votes)
      .where(and(eq(schema.votes.issueId, issue.id), eq(schema.votes.userId, user.id)))
      .limit(1);

    const voters = await db
      .select({ id: schema.users.id, displayName: schema.users.displayName })
      .from(schema.votes)
      .innerJoin(schema.users, eq(schema.users.id, schema.votes.userId))
      .where(eq(schema.votes.issueId, issue.id));

    return c.json({
      votes: Number(voteCount[0]?.count || 0),
      hasVoted: hasVoted.length > 0,
      voters: voters.map(v => ({ id: v.id, displayName: v.displayName })),
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to fetch votes'] }, 500);
  }
});

app.post('/rest/api/2/issue/:idOrKey/votes', requireAuth, requireIssueAccess(), async (c) => {
  try {
    const idOrKey = c.req.param('idOrKey');
    const user = c.get('user')!;
    const issue = await getIssue(idOrKey);
    if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

    await db.insert(schema.votes)
      .values({ issueId: issue.id, userId: user.id })
      .onConflictDoNothing();

    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to vote'] }, 500);
  }
});

app.delete('/rest/api/2/issue/:idOrKey/votes', requireAuth, requireIssueAccess(), async (c) => {
  try {
    const idOrKey = c.req.param('idOrKey');
    const user = c.get('user')!;
    const issue = await getIssue(idOrKey);
    if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

    await db.delete(schema.votes)
      .where(and(eq(schema.votes.issueId, issue.id), eq(schema.votes.userId, user.id)));

    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to remove vote'] }, 500);
  }
});

export default app;
