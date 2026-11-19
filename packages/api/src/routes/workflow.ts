import { Hono } from 'hono';
import { notifyRequestStatusChange } from '../servicedesk/outbound-mail';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requirePermission, requireIssueAccess } from '../middleware/permissions';
import { getAvailableTransitions, doTransition } from '../workflow/engine';
import { getIssue, invalidateIssueKeyCache } from '../issues/service';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@veqsio/db';
import { eq, inArray } from 'drizzle-orm';
import { invalidateIssueCache } from '../middleware/cache';
import { normalizeCategory, TransitionValidationError } from '../workflow/transition-meta';
import type { AppContext } from '../auth/middleware';
import { publishIssue } from '../realtime/publish';
import { loadScreenFields } from '../workflow/screen';
import { notifyIssueUpdated, notifyIssueAssigned } from '../services/notifications';
import { customerSideUserIds } from '../servicedesk/access';

import { db } from '../db';

const app = new Hono<AppContext>();

app.use('/rest/api/2/workflow*', sessionMiddleware);
app.use('/rest/api/2/issue/*/transitions', sessionMiddleware);

app.get('/rest/api/2/workflow', requireAuth, async (c) => {
  const workflows = await db.select().from(schema.workflows);
  return c.json({
    startAt: 0,
    maxResults: workflows.length,
    total: workflows.length,
    isLast: true,
    values: workflows.map(w => ({ id: String(w.id), name: w.name, description: w.description })),
  });
});

app.get('/rest/api/2/issue/:idOrKey/transitions', requireAuth, requireIssueAccess(), async (c) => {
  const idOrKey = c.req.param('idOrKey');
  const user = c.get('user')!;
  const issue = await getIssue(idOrKey);
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);
  const transitions = await getAvailableTransitions(issue.id, user.id);

  const populatedTransitions = await Promise.all(
    transitions.map(async (t) => {
      const fields: Record<string, any> = {};
      // Ordered description of the screen's fields (additive): what the dialog renders and the server validates.
      const screenFields: Array<Record<string, unknown>> = [];
      if (t.screenId) {
        for (const f of await loadScreenFields(t.screenId)) {
          fields[f.key] = { required: f.required, name: f.name, schema: { type: f.custom ? 'custom' : f.type, custom: f.custom ? f.type : undefined }, ...(f.options ? { allowedValues: f.options } : {}) };
          screenFields.push({ key: f.key, name: f.name, type: f.type, custom: f.custom, required: f.required, ...(f.options ? { options: f.options } : {}) });
        }
      }
      // Fields demanded by validators (additive): the UI renders resolution / comment natively.
      for (const name of t.meta.requiredFields) {
        fields[name] = { ...(fields[name] || { schema: { type: 'string' } }), required: true };
      }
      const categoryKey = normalizeCategory(t.to.statusCategory);
      return {
        id: t.id,
        name: t.name,
        to: {
          id: t.to.id,
          name: t.to.name,
          statusCategory: {
            key: t.to.statusCategory,
            normalizedKey: categoryKey,
            name: categoryKey === 'done' ? 'Done' : categoryKey === 'in_progress' ? 'In Progress' : 'To Do',
          },
        },
        hasScreen: t.hasScreen,
        fields,
        screenFields,
        requiresResolution: t.meta.requiresResolution,
        requiresComment: t.meta.requiresComment,
        requiresInput: t.meta.requiresInput,
        requiredFields: t.meta.requiredFields,
      };
    })
  );

  return c.json({ transitions: populatedTransitions });
});

app.post('/rest/api/2/issue/:idOrKey/transitions', requireAuth, requirePermission('TRANSITION_ISSUES'), async (c) => {
  const idOrKey = c.req.param('idOrKey');
  const body = await c.req.json();
  const user = c.get('user')!;
  const issue = await getIssue(idOrKey);
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

  const transitionId = body.transition?.id || body.transitionId;
  if (!transitionId) {
    return c.json({ errorMessages: ['Transition ID required'] }, 400);
  }

  try {
    // Jira-style comment: update.comment[].add.body (or a plain `comment` string)
    const commentText: string | undefined =
      body.update?.comment?.[0]?.add?.body ?? (typeof body.comment === 'string' ? body.comment : undefined);
    const txFields: Record<string, any> = { ...(body.fields || {}) };
    if (commentText && txFields.comment === undefined) txFields.comment = commentText;
    const result = await doTransition(issue.id, Number(transitionId), user.id, txFields, { comment: commentText });
    // Service requests: tell the customer (per desk switches); no-op for ordinary issues
    await notifyRequestStatusChange(issue.id, user.id, commentText);
    publishIssue('issue.transitioned', issue, user.id);
    await invalidateIssueKeyCache(issue.key);
    await invalidateIssueCache(issue.key);
    // Screen field changes notify like a normal edit (same recipients rules: watchers, assignee, never the actor).
    if (result.changes.length > 0) {
      try {
        const updated = await getIssue(issue.id);
        if (updated) {
          const [sr] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, issue.id)).limit(1);
          await notifyIssueUpdated(updated as any, result.changes, user.id, undefined, sr ? await customerSideUserIds(sr) : undefined);
          const newAssignee = updated.fields?.assignee?.id;
          if (result.changes.some((x) => x.field === 'assignee') && newAssignee && newAssignee !== issue.fields?.assignee?.id) await notifyIssueAssigned(updated as any, newAssignee, user.id);
        }
      } catch (e) {
        console.error('[notification] transition screen fields:', e);
      }
    }
    const { emitIssueTransitioned } = await import('../services/automation-engine');
    await emitIssueTransitioned(issue.id, user.id, Number(transitionId));
    return c.json({});
  } catch (err: any) {
    if (err instanceof TransitionValidationError) {
      return c.json({ errorMessages: [err.message], validationErrors: err.errors, errors: err.fieldErrors }, 400);
    }
    return c.json({ errorMessages: [err.message] }, 400);
  }
});

export default app;
