import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { AppContext } from '../auth/middleware';
import { canManageLabels, invalidateLabelCaches, listLabelsWithCounts } from '../labels/service';
import { LABEL_PALETTE, planLabelMerge, validateLabelColor, validateLabelName } from '../labels/labels';

const app = new Hono<AppContext>();
app.use('/rest/api/2/label*', sessionMiddleware);

async function requireManager(c: any) {
  const user = c.get('user');
  if (!(await canManageLabels(user))) return c.json({ errorMessages: ['Managing labels requires project administrator permission'] }, 403);
  return null;
}

async function readJson(c: any): Promise<Record<string, any> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/**
 * List labels. Jira-compatible `values` (array of names) plus additive `labels` with colour, flag and usage.
 * Any signed-in user may read: the picker needs it.
 */
app.get('/rest/api/2/label', requireAuth, async (c) => {
  const rows = await listLabelsWithCounts();
  const q = (c.req.query('query') || '').trim().toLowerCase();
  const filtered = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  return c.json({
    maxResults: filtered.length,
    startAt: 0,
    total: filtered.length,
    isLast: true,
    values: filtered.map((r) => r.name),
    labels: filtered,
    palette: LABEL_PALETTE,
  });
});

app.post('/rest/api/2/label', requireAuth, async (c) => {
  const denied = await requireManager(c);
  if (denied) return denied;
  const body = await readJson(c);
  if (!body) return c.json({ errorMessages: ['Invalid JSON body'] }, 400);
  const name = validateLabelName(body.name);
  if (!name.ok) return c.json({ errorMessages: [name.error] }, 400);
  const color = validateLabelColor(body.color);
  if (!color.ok) return c.json({ errorMessages: [color.error] }, 400);
  const existing = await db.select({ id: schema.labels.id }).from(schema.labels).where(eq(schema.labels.name, name.value)).limit(1);
  if (existing[0]) return c.json({ errorMessages: [`Label "${name.value}" already exists`], conflictId: existing[0].id }, 409);
  const [created] = await db
    .insert(schema.labels)
    .values({ name: name.value, color: color.value, removeOnResolve: body.removeOnResolve === true })
    .returning();
  return c.json({ ...created, issueCount: 0 }, 201);
});

app.put('/rest/api/2/label/:id', requireAuth, async (c) => {
  const denied = await requireManager(c);
  if (denied) return denied;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ errorMessages: ['Invalid label id'] }, 400);
  const body = await readJson(c);
  if (!body) return c.json({ errorMessages: ['Invalid JSON body'] }, 400);

  const [label] = await db.select().from(schema.labels).where(eq(schema.labels.id, id)).limit(1);
  if (!label) return c.json({ errorMessages: ['Label not found'] }, 404);

  const patch: Partial<typeof schema.labels.$inferInsert> = {};
  if (body.name !== undefined) {
    const name = validateLabelName(body.name);
    if (!name.ok) return c.json({ errorMessages: [name.error] }, 400);
    if (name.value !== label.name) {
      const clash = await db.select({ id: schema.labels.id }).from(schema.labels).where(eq(schema.labels.name, name.value)).limit(1);
      if (clash[0] && clash[0].id !== id) {
        return c.json(
          { errorMessages: [`Label "${name.value}" already exists. Merge into it instead of renaming.`], conflictId: clash[0].id },
          409,
        );
      }
      patch.name = name.value;
    }
  }
  if (body.color !== undefined) {
    const color = validateLabelColor(body.color);
    if (!color.ok) return c.json({ errorMessages: [color.error] }, 400);
    patch.color = color.value;
  }
  if (body.removeOnResolve !== undefined) {
    if (typeof body.removeOnResolve !== 'boolean') return c.json({ errorMessages: ['removeOnResolve must be a boolean'] }, 400);
    patch.removeOnResolve = body.removeOnResolve;
  }
  if (Object.keys(patch).length > 0) {
    await db.update(schema.labels).set(patch).where(eq(schema.labels.id, id));
    await invalidateLabelCaches();
  }

  const [row] = (await listLabelsWithCounts()).filter((r) => r.id === id);
  return c.json(row);
});

/** Merge `:id` (source) into `targetId`: issues move over, the source label is deleted. */
app.post('/rest/api/2/label/:id/merge', requireAuth, async (c) => {
  const denied = await requireManager(c);
  if (denied) return denied;
  const sourceId = Number(c.req.param('id'));
  const body = await readJson(c);
  const targetId = Number(body?.targetId);
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId)) return c.json({ errorMessages: ['sourceId and targetId must be integers'] }, 400);
  if (sourceId === targetId) return c.json({ errorMessages: ['Cannot merge a label into itself'] }, 400);

  const rows = await db.select().from(schema.labels).where(inArray(schema.labels.id, [sourceId, targetId]));
  const source = rows.find((r) => r.id === sourceId);
  const target = rows.find((r) => r.id === targetId);
  if (!source || !target) return c.json({ errorMessages: ['Label not found'] }, 404);

  const result = await db.transaction(async (tx) => {
    const sourceIssues = (await tx.select({ id: schema.issueLabels.issueId }).from(schema.issueLabels).where(eq(schema.issueLabels.labelId, sourceId))).map((r) => r.id);
    const targetIssues = (await tx.select({ id: schema.issueLabels.issueId }).from(schema.issueLabels).where(eq(schema.issueLabels.labelId, targetId))).map((r) => r.id);
    const plan = planLabelMerge(sourceIssues, targetIssues);
    if (plan.attachToIssueIds.length > 0) {
      await tx
        .insert(schema.issueLabels)
        .values(plan.attachToIssueIds.map((issueId) => ({ issueId, labelId: targetId })))
        .onConflictDoNothing();
      await tx.insert(schema.issueHistory).values(
        plan.attachToIssueIds.map((issueId) => ({
          issueId,
          fieldName: 'labels',
          oldValue: source.name,
          newValue: target.name,
          authorId: c.get('user')!.id,
        })),
      );
    }
    // issue_labels rows of the source are removed by the cascade on label delete.
    await tx.delete(schema.labels).where(eq(schema.labels.id, sourceId));
    return plan;
  });

  await invalidateLabelCaches();
  const [merged] = (await listLabelsWithCounts()).filter((r) => r.id === targetId);
  return c.json({ merged, moved: result.attachToIssueIds.length, duplicates: result.alreadyHaveTarget.length });
});

/** Delete unused labels in bulk (`?unused=true`). Labels still attached to issues are never touched. */
app.delete('/rest/api/2/label', requireAuth, async (c) => {
  const denied = await requireManager(c);
  if (denied) return denied;
  if (c.req.query('unused') !== 'true') return c.json({ errorMessages: ['Use ?unused=true to delete all unused labels'] }, 400);
  const used = db.select({ id: schema.issueLabels.labelId }).from(schema.issueLabels);
  const deleted = await db.delete(schema.labels).where(notInArray(schema.labels.id, used)).returning({ id: schema.labels.id });
  return c.json({ deleted: deleted.length });
});

/** Delete one label. Refused while issues still carry it, so nothing disappears silently. */
app.delete('/rest/api/2/label/:id', requireAuth, async (c) => {
  const denied = await requireManager(c);
  if (denied) return denied;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ errorMessages: ['Invalid label id'] }, 400);
  const [label] = await db.select().from(schema.labels).where(eq(schema.labels.id, id)).limit(1);
  if (!label) return c.json({ errorMessages: ['Label not found'] }, 404);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.issueLabels).where(eq(schema.issueLabels.labelId, id));
  if (n > 0) {
    return c.json({ errorMessages: [`Label is used by ${n} issue${n === 1 ? '' : 's'}. Merge it into another label or remove it from those issues first.`], issueCount: n }, 409);
  }
  await db.delete(schema.labels).where(and(eq(schema.labels.id, id)));
  return c.body(null, 204);
});

export default app;
