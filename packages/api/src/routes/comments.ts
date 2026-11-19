import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requirePermission } from '../middleware/permissions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@veqsio/db';
import { eq, and, desc, count, inArray } from 'drizzle-orm';
import { getIssue } from '../issues/service';
import { queueEmails } from '../services/email';
import { notifyCommentAdded } from '../services/notifications';
import { issueDeskAccess } from '../servicedesk/service';
import { notifyRequestComment } from '../servicedesk/outbound-mail';
import { customerSideUserIds } from '../servicedesk/access';
import type { AppContext } from '../auth/middleware';
import { publishIssue, publishIssueById } from '../realtime/publish';

const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

const app = new Hono<AppContext>();
app.use('/rest/api/2/issue/*/comment*', sessionMiddleware);

app.get('/rest/api/2/issue/:idOrKey/comment', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const idOrKey = c.req.param('idOrKey');
  const issue = await getIssue(idOrKey);
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

  const access = await issueDeskAccess(c.get('user'), issue.id);
  const visibility = access.staff ? undefined : eq(schema.comments.isInternal, false);
  const where = visibility ? and(eq(schema.comments.issueId, issue.id), visibility) : eq(schema.comments.issueId, issue.id);

  const comments = await db
    .select()
    .from(schema.comments)
    .where(where)
    .orderBy(desc(schema.comments.createdAt));

  const total = await db
    .select({ count: count() })
    .from(schema.comments)
    .where(where);

  const authorIds = [...new Set(comments.map((cm) => cm.authorId).filter((x): x is number => !!x))];
  const authors = authorIds.length ? await db.select({ id: schema.users.id, displayName: schema.users.displayName, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, authorIds)) : [];
  const authorOf = (id: number | null) => {
    const a = authors.find((x) => x.id === id);
    return a ? { id: a.id, displayName: a.displayName, isAgent: a.username.startsWith('agent:') } : { id };
  };
  const me = c.get('user')?.id;
  const reactionRows = comments.length
    ? await db.select().from(schema.commentReactions).where(inArray(schema.commentReactions.commentId, comments.map((cm) => cm.id)))
    : [];
  const reactionsOf = (id: number) => {
    const byEmoji = new Map<string, { emoji: string; count: number; me: boolean }>();
    for (const r of reactionRows) {
      if (r.commentId !== id) continue;
      const e = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, me: false };
      e.count += 1;
      if (r.userId === me) e.me = true;
      byEmoji.set(r.emoji, e);
    }
    return [...byEmoji.values()];
  };

  return c.json({
    startAt: 0,
    maxResults: comments.length,
    total: Number(total[0]?.count || 0),
    isLast: true,
    comments: comments.map(cm => ({
      id: String(cm.id),
      self: `/rest/api/2/issue/${idOrKey}/comment/${cm.id}`,
      author: authorOf(cm.authorId),
      body: cm.body,
      internal: !!cm.isInternal,
      parentId: cm.parentCommentId != null ? String(cm.parentCommentId) : null,
      reactions: reactionsOf(cm.id),
      created: cm.createdAt!.toISOString(),
      updated: cm.updatedAt!.toISOString(),
    })),
  });
});

app.post('/rest/api/2/issue/:idOrKey/comment', requireAuth, requirePermission('ADD_COMMENTS'), async (c) => {
  const idOrKey = c.req.param('idOrKey');
  const body = await c.req.json();
  const user = c.get('user')!;
  const issue = await getIssue(idOrKey);
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

  if (typeof body?.body !== 'string' || body.body.trim() === '' || body.body.length > 100_000) {
    return c.json({ errorMessages: ['Comment body is required (max 100000 characters)'] }, 400);
  }
  const wantsInternal = body.internal === true;
  const access = await issueDeskAccess(user, issue.id);
  if (wantsInternal && !(access.isRequest && access.staff)) {
    return c.json({ errorMessages: ['Internal comments are only available to service desk agents on service requests'] }, 400);
  }
  // Non-staff users cannot comment on service requests through the generic API (they use the portal).
  if (access.isRequest && !access.staff) return c.json({ errorMessages: ['Forbidden'] }, 403);

  // Threading: the parent must be a comment on the same issue that this user may see.
  let parentId: number | null = null;
  let isInternal = wantsInternal;
  if (body.parentId !== undefined && body.parentId !== null) {
    const pid = Number(body.parentId);
    if (!Number.isInteger(pid) || pid <= 0) return c.json({ errorMessages: ['parentId must be a comment id'] }, 400);
    const [parent] = await db.select().from(schema.comments)
      .where(and(eq(schema.comments.id, pid), eq(schema.comments.issueId, issue.id))).limit(1);
    // Hidden internal notes look exactly like missing comments to non-staff.
    if (!parent || (parent.isInternal && !access.staff)) {
      return c.json({ errorMessages: ['Parent comment not found on this issue'] }, 400);
    }
    parentId = parent.id;
    // A reply to an internal note can never be visible to the customer.
    if (parent.isInternal) isInternal = true;
  }

  const [comment] = await db.insert(schema.comments).values({
    issueId: issue.id,
    body: body.body,
    authorId: user.id,
    isInternal,
    parentCommentId: parentId,
  }).returning();

  publishIssue('comment.added', issue, user.id);
  const { emitIssueCommented } = await import('../services/automation-engine');
  await emitIssueCommented(issue.id, user.id, comment.id);

  // Notify watchers, assignee, reporter (excluding comment author)
  try {
    if (isInternal) {
      // Internal notes never reach the customer: notify only the assignee (an agent), if it is not the author.
      const rcpt = [issue.fields?.assignee?.id].filter((id): id is number => !!id && id !== user.id && id !== access.customerId);
      if (rcpt.length) await notifyCommentAdded(comment, issue, rcpt);
    } else if (access.isRequest) {
      // Public agent reply on a request: the customer side gets the threaded desk mail instead of the generic one.
      const [sr] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, issue.id)).limit(1);
      const customerSide = sr ? await customerSideUserIds(sr) : [];
      await notifyCommentAdded(comment, issue, undefined, customerSide);
      await notifyRequestComment(comment, issue.id);
    } else {
      await notifyCommentAdded(comment, issue);
    }
  } catch (e) {
    console.error('[notification] Failed to send comment notification:', e);
  }

  return c.json({
    id: String(comment.id),
    self: `/rest/api/2/issue/${idOrKey}/comment/${comment.id}`,
    author: { id: user.id, displayName: user.displayName, isAgent: user.username.startsWith('agent:') },
    body: comment.body,
    internal: !!comment.isInternal,
    parentId: comment.parentCommentId != null ? String(comment.parentCommentId) : null,
    created: comment.createdAt!.toISOString(),
  }, 201);
});

app.put('/rest/api/2/issue/:idOrKey/comment/:commentId', requireAuth, requirePermission('EDIT_OWN_COMMENTS'), async (c) => {
  try {
    const commentId = Number(c.req.param('commentId'));
    const body = await c.req.json();
    const user = c.get('user')!;
    if (typeof body?.body !== 'string' || body.body.length === 0 || body.body.length > 100_000) return c.json({ errorMessages: ['body must be text'] }, 400);
    // the comment must belong to the issue in the URL: the permission was checked for that issue's project, not for another one
    const issue = await getIssue(c.req.param('idOrKey'));
    if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

    const comments = await db.select().from(schema.comments).where(and(eq(schema.comments.id, commentId), eq(schema.comments.issueId, issue.id))).limit(1);
    if (comments.length === 0) return c.json({ errorMessages: ['Comment not found'] }, 404);
    if (comments[0].authorId !== user.id) return c.json({ errorMessages: ['Forbidden'] }, 403);

    await db.update(schema.comments)
      .set({ body: body.body, updatedAt: new Date() })
      .where(eq(schema.comments.id, commentId));
    publishIssueById('comment.added', comments[0].issueId, user.id);

    return c.json({ id: String(commentId), body: body.body });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update comment'] }, 500);
  }
});

app.delete('/rest/api/2/issue/:idOrKey/comment/:commentId', requireAuth, requirePermission('DELETE_OWN_COMMENTS'), async (c) => {
  try {
    const commentId = Number(c.req.param('commentId'));
    const user = c.get('user')!;
    const issue = await getIssue(c.req.param('idOrKey'));
    if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

    const comments = await db.select().from(schema.comments).where(and(eq(schema.comments.id, commentId), eq(schema.comments.issueId, issue.id))).limit(1);
    if (comments.length === 0) return c.json({ errorMessages: ['Comment not found'] }, 404);
    if (comments[0].authorId !== user.id) return c.json({ errorMessages: ['Forbidden'] }, 403);

    await db.delete(schema.comments).where(eq(schema.comments.id, commentId));
    publishIssueById('comment.added', comments[0].issueId, user.id);
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to delete comment'] }, 500);
  }
});

/** Reactions are a fixed set so the UI and the data stay predictable. */
export const REACTION_EMOJI = ['👍', '👎', '❤️', '🎉', '😄', '👀', '🚀'] as const;

// Toggle the caller's reaction on a comment: adds it, or removes it when already set.
app.post('/rest/api/2/issue/:idOrKey/comment/:commentId/reaction', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const issue = await getIssue(c.req.param('idOrKey'));
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);
  const commentId = Number(c.req.param('commentId'));
  if (!Number.isInteger(commentId)) return c.json({ errorMessages: ['Comment not found'] }, 404);
  const body = await c.req.json().catch(() => null) as { emoji?: unknown } | null;
  const emoji = body?.emoji;
  if (typeof emoji !== 'string' || !(REACTION_EMOJI as readonly string[]).includes(emoji)) {
    return c.json({ errorMessages: [`emoji must be one of: ${REACTION_EMOJI.join(' ')}`] }, 400);
  }
  const user = c.get('user')!;
  const [comment] = await db.select().from(schema.comments)
    .where(and(eq(schema.comments.id, commentId), eq(schema.comments.issueId, issue.id))).limit(1);
  if (!comment) return c.json({ errorMessages: ['Comment not found'] }, 404);
  if (comment.isInternal) {
    const access = await issueDeskAccess(user, issue.id);
    if (!access.staff) return c.json({ errorMessages: ['Comment not found'] }, 404);
  }
  const key = and(eq(schema.commentReactions.commentId, commentId), eq(schema.commentReactions.userId, user.id), eq(schema.commentReactions.emoji, emoji));
  const existing = await db.select({ c: count() }).from(schema.commentReactions).where(key);
  let active: boolean;
  if (Number(existing[0]?.c) > 0) {
    await db.delete(schema.commentReactions).where(key);
    active = false;
  } else {
    await db.insert(schema.commentReactions).values({ commentId, userId: user.id, emoji }).onConflictDoNothing();
    active = true;
  }
  publishIssueById('comment.added', issue.id, user.id);
  return c.json({ commentId: String(commentId), emoji, active });
});

export default app;
