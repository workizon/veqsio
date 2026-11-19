import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import { logWorkflowChange, logWorkflowChanges, diffTransition, describeItem, listWorkflowChanges, workflowsUsingStatus, type TransitionSnapshot } from '../workflow/governance';
import { requireGlobalPermission } from '../rbac/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, inArray, sql, ne, isNull } from 'drizzle-orm';
import type { AppContext } from '../auth/middleware';
import { STATUS_CATEGORY_VALUES, STATUS_GROUPS } from '../workflow/status-groups';
import {
  TYPE_CATALOGUE, validateItems, normalizeItems, analyzeGraph, workflowStatusIds, validateLayout,
  type ItemKind, type GraphTransition,
} from '../workflow/definition';

/**
 * Workflow designer API (SYSTEM_ADMIN only).
 *
 *   GET    /rest/api/2/admin/workflow/types
 *   GET    /rest/api/2/admin/workflow
 *   POST   /rest/api/2/admin/workflow                    {name, description?, cloneFromId?}
 *   GET    /rest/api/2/admin/workflow/:id
 *   PUT    /rest/api/2/admin/workflow/:id                {name?, description?}
 *   DELETE /rest/api/2/admin/workflow/:id
 *   PUT    /rest/api/2/admin/workflow/:id/layout         {nodes: {statusId: {x, y}}}
 *   POST   /rest/api/2/admin/workflow/:id/transition
 *   PUT    /rest/api/2/admin/workflow/:id/transition/:tid
 *   DELETE /rest/api/2/admin/workflow/:id/transition/:tid
 *   GET|POST /rest/api/2/admin/status, PUT|DELETE /rest/api/2/admin/status/:id
 */
const app = new Hono<AppContext>();

const guard = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const;

/** zod failures use the same `{errorMessages: []}` shape as every other error. */
function body<T extends z.ZodTypeAny>(s: T) {
  return zValidator('json', s, (result, c) => {
    if (!result.success) {
      const msgs = result.error.issues.map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`);
      return c.json({ errorMessages: msgs }, 400);
    }
  });
}

/** jsonb lists are normally arrays, but some seeds stored them as JSON strings. */
function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

function parseId(v: string): number | null {
  return /^\d+$/.test(v) && Number(v) < 2_147_483_647 ? Number(v) : null;
}

const CATEGORIES = STATUS_CATEGORY_VALUES;
const HEX = /^#[0-9a-fA-F]{6}$/;
const CATEGORY_COLORS: Record<string, string> = Object.fromEntries(STATUS_GROUPS.map((g) => [g.id, g.color]));

const itemList = z.array(z.record(z.string(), z.unknown())).max(50);

/* ------------------------------------------------------------------ */
/*  Supported types                                                    */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/workflow/types', ...guard, async (c) => {
  const [roles, groups, resolutions, users] = await Promise.all([
    db.select({ id: schema.projectRoles.id, name: schema.projectRoles.name }).from(schema.projectRoles),
    db.select({ id: schema.groups.id, name: schema.groups.name }).from(schema.groups),
    db.select({ id: schema.resolutions.id, name: schema.resolutions.name }).from(schema.resolutions),
    db.select({ id: schema.users.id, name: schema.users.displayName }).from(schema.users).where(eq(schema.users.active, true)).limit(500),
  ]);
  const screens = await db.select({ id: schema.screens.id, name: schema.screens.name }).from(schema.screens);
  return c.json({
    conditions: TYPE_CATALOGUE.condition,
    validators: TYPE_CATALOGUE.validator,
    postFunctions: TYPE_CATALOGUE.postFunction,
    lookups: { role: roles, group: groups, resolution: resolutions, user: users, screen: screens },
    categories: [...CATEGORIES],
  });
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function loadWorkflowDetail(id: number) {
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).limit(1);
  if (!wf) return null;
  const transitions = await db.select().from(schema.workflowTransitions)
    .where(eq(schema.workflowTransitions.workflowId, id)).orderBy(schema.workflowTransitions.id);
  const layout = ((wf.designerLayout as any)?.nodes ?? {}) as Record<string, { x: number; y: number }>;
  const graph: GraphTransition[] = transitions.map((t) => ({ id: t.id, name: t.name, fromStatusId: t.fromStatusId, toStatusId: t.toStatusId }));
  const statusIds = workflowStatusIds(layout, graph);
  const statuses = statusIds.length > 0
    ? await db.select().from(schema.statuses).where(inArray(schema.statuses.id, statusIds)).orderBy(schema.statuses.sortOrder, schema.statuses.id)
    : [];
  const names = Object.fromEntries(statuses.map((s) => [s.id, s.name]));
  const usage = await workflowUsage([id]);
  return {
    id: wf.id,
    name: wf.name,
    description: wf.description,
    isDefault: !!wf.isDefault,
    statuses: statuses.map(serializeStatus),
    transitions: transitions.map((t) => ({
      id: t.id, name: t.name, fromStatusId: t.fromStatusId, toStatusId: t.toStatusId, screenId: t.screenId,
      conditions: asList(t.conditions), validators: asList(t.validators), postFunctions: asList(t.postFunctions),
      // Plain-language answer to "who may use this transition", shown in the designer.
      whoMayMove: whoMayMove(asList(t.conditions)),
    })),
    positions: layout,
    warnings: analyzeGraph(statuses.map((s) => s.id), graph, names),
    schemes: usage.get(id)?.schemes ?? [],
    projects: usage.get(id)?.projects ?? [],
  };
}

/** Conditions decide who may move an issue through a transition; with none, everyone who may edit the issue can. */
export function whoMayMove(conditions: unknown[]): string {
  if (conditions.length === 0) return 'Anyone who can transition the issue (no conditions)';
  return `Only if: ${conditions.map((c) => describeItem(c as Record<string, unknown>)).join(' AND ')}`;
}

function serializeStatus(s: typeof schema.statuses.$inferSelect) {
  return { id: s.id, name: s.name, description: s.description, category: s.category, color: s.color ?? CATEGORY_COLORS[s.category] ?? '#666666', allowNewIssues: s.allowNewIssues !== false };
}

/** Schemes and projects that use each workflow (default workflow: every project without a scheme counts too). */
async function workflowUsage(ids: number[]) {
  const out = new Map<number, { schemes: { id: number; name: string }[]; projects: { id: number; key: string; name: string }[] }>();
  for (const id of ids) out.set(id, { schemes: [], projects: [] });
  if (ids.length === 0) return out;
  const items = await db.select({ workflowId: schema.workflowSchemeItems.workflowId, schemeId: schema.workflowSchemeItems.schemeId })
    .from(schema.workflowSchemeItems).where(inArray(schema.workflowSchemeItems.workflowId, ids));
  const schemeIds = [...new Set(items.map((i) => i.schemeId))];
  const schemes = schemeIds.length ? await db.select().from(schema.workflowSchemes).where(inArray(schema.workflowSchemes.id, schemeIds)) : [];
  const assoc = schemeIds.length ? await db.select().from(schema.workflowSchemeAssociations).where(inArray(schema.workflowSchemeAssociations.schemeId, schemeIds)) : [];
  const projIds = [...new Set(assoc.map((a) => a.projectId))];
  const projects = projIds.length ? await db.select().from(schema.projects).where(inArray(schema.projects.id, projIds)) : [];
  const schemeMap = new Map(schemes.map((s) => [s.id, s]));
  const projMap = new Map(projects.map((p) => [p.id, p]));
  for (const it of items) {
    const entry = out.get(it.workflowId)!;
    const sch = schemeMap.get(it.schemeId);
    if (sch && !entry.schemes.some((s) => s.id === sch.id)) entry.schemes.push({ id: sch.id, name: sch.name });
    for (const a of assoc.filter((x) => x.schemeId === it.schemeId)) {
      const p = projMap.get(a.projectId);
      if (p && !entry.projects.some((x) => x.id === p.id)) entry.projects.push({ id: p.id, key: p.projectKey, name: p.name });
    }
  }
  return out;
}

async function checkTransitionInput(
  workflowId: number,
  input: { name?: string; fromStatusId?: number | null; toStatusId?: number; screenId?: number | null; conditions?: unknown; validators?: unknown; postFunctions?: unknown },
  excludeTransitionId?: number,
  current?: { name: string; fromStatusId: number | null; toStatusId: number },
): Promise<string[]> {
  const errors: string[] = [];
  const kinds: [ItemKind, unknown, string][] = [
    ['condition', input.conditions, 'conditions'], ['validator', input.validators, 'validators'], ['postFunction', input.postFunctions, 'postFunctions'],
  ];
  for (const [kind, items] of kinds) {
    if (items === undefined) continue;
    for (const e of validateItems(kind, items)) errors.push(e.message);
  }
  const ids = [input.fromStatusId, input.toStatusId].filter((x): x is number => typeof x === 'number');
  if (ids.length) {
    const found = await db.select({ id: schema.statuses.id }).from(schema.statuses).where(inArray(schema.statuses.id, ids));
    const have = new Set(found.map((f) => f.id));
    for (const id of ids) if (!have.has(id)) errors.push(`Status ${id} does not exist`);
  }
  if (typeof input.screenId === 'number') {
    const [s] = await db.select({ id: schema.screens.id }).from(schema.screens).where(eq(schema.screens.id, input.screenId)).limit(1);
    if (!s) errors.push(`Screen ${input.screenId} does not exist`);
  }
  // Duplicate (same name, from, to) is almost certainly a mistake.
  const name = input.name ?? current?.name;
  const from = input.fromStatusId === undefined ? current?.fromStatusId ?? null : input.fromStatusId;
  const to = input.toStatusId ?? current?.toStatusId;
  if (name !== undefined && to !== undefined && errors.length === 0) {
    const same = await db.select({ id: schema.workflowTransitions.id }).from(schema.workflowTransitions).where(and(
      eq(schema.workflowTransitions.workflowId, workflowId),
      sql`lower(${schema.workflowTransitions.name}) = ${name.trim().toLowerCase()}`,
      eq(schema.workflowTransitions.toStatusId, to),
      from === null ? isNull(schema.workflowTransitions.fromStatusId) : eq(schema.workflowTransitions.fromStatusId, from),
      excludeTransitionId ? ne(schema.workflowTransitions.id, excludeTransitionId) : sql`true`,
    )).limit(1);
    if (same.length) errors.push(`A transition named "${name}" between these statuses already exists`);
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/*  Workflows                                                          */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/workflow', ...guard, async (c) => {
  const workflows = await db.select().from(schema.workflows).orderBy(schema.workflows.id);
  const counts = await db.select({ workflowId: schema.workflowTransitions.workflowId, n: sql<number>`count(*)::int` })
    .from(schema.workflowTransitions).groupBy(schema.workflowTransitions.workflowId);
  const countMap = new Map(counts.map((r) => [r.workflowId, r.n]));
  const usage = await workflowUsage(workflows.map((w) => w.id));
  return c.json({
    workflows: workflows.map((w) => ({
      id: w.id, name: w.name, description: w.description, isDefault: !!w.isDefault,
      transitionCount: countMap.get(w.id) ?? 0,
      schemes: usage.get(w.id)?.schemes ?? [],
      projects: usage.get(w.id)?.projects ?? [],
    })),
  });
});

const nameField = z.string().trim().min(1, 'Name is required').max(255);

app.post('/rest/api/2/admin/workflow', ...guard, body(z.object({
  name: nameField,
  description: z.string().max(2000).nullish(),
  cloneFromId: z.number().int().positive().optional(),
})), async (c) => {
  const input = c.req.valid('json');
  const dup = await db.select({ id: schema.workflows.id }).from(schema.workflows).where(sql`lower(${schema.workflows.name}) = ${input.name.toLowerCase()}`).limit(1);
  if (dup.length) return c.json({ errorMessages: [`A workflow named "${input.name}" already exists`] }, 409);

  let source: typeof schema.workflows.$inferSelect | undefined;
  if (input.cloneFromId) {
    [source] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, input.cloneFromId)).limit(1);
    if (!source) return c.json({ errorMessages: ['Workflow to clone not found'] }, 404);
  }

  const created = await db.transaction(async (tx) => {
    const [wf] = await tx.insert(schema.workflows).values({
      name: input.name,
      description: input.description ?? source?.description ?? null,
      isDefault: false,
      designerLayout: source?.designerLayout ?? { nodes: {} },
    }).returning();
    if (source) {
      const ts = await tx.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, source.id)).orderBy(schema.workflowTransitions.id);
      if (ts.length) {
        await tx.insert(schema.workflowTransitions).values(ts.map((t) => ({
          workflowId: wf.id, name: t.name, fromStatusId: t.fromStatusId, toStatusId: t.toStatusId, screenId: t.screenId,
          conditions: asList(t.conditions), validators: asList(t.validators), postFunctions: asList(t.postFunctions),
        })));
      }
    }
    return wf;
  });
  await logWorkflowChange(created.id, c.get('user')?.id, { targetType: 'workflow', action: 'created', summary: source ? `Workflow created as a copy of "${source.name}"` : 'Workflow created' });
  return c.json({ id: created.id, name: created.name }, 201);
});

app.get('/rest/api/2/admin/workflow/:id', ...guard, async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ errorMessages: ['Invalid workflow id'] }, 400);
  const detail = await loadWorkflowDetail(id);
  if (!detail) return c.json({ errorMessages: ['Workflow not found'] }, 404);
  return c.json(detail);
});

app.put('/rest/api/2/admin/workflow/:id', ...guard, body(z.object({
  name: nameField.optional(),
  description: z.string().max(2000).nullish(),
  // true makes this the default workflow (the previous default is demoted in the same transaction); false is refused
  // because exactly one workflow is always the default.
  isDefault: z.boolean().optional(),
})), async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ errorMessages: ['Invalid workflow id'] }, 400);
  const input = c.req.valid('json');
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).limit(1);
  if (!wf) return c.json({ errorMessages: ['Workflow not found'] }, 404);
  if (input.name !== undefined) {
    const dup = await db.select({ id: schema.workflows.id }).from(schema.workflows)
      .where(and(sql`lower(${schema.workflows.name}) = ${input.name.toLowerCase()}`, ne(schema.workflows.id, id))).limit(1);
    if (dup.length) return c.json({ errorMessages: [`A workflow named "${input.name}" already exists`] }, 409);
  }
  const patch: Partial<typeof schema.workflows.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.isDefault === false && wf.isDefault) {
    return c.json({ errorMessages: [`"${wf.name}" is the default workflow. Make another workflow the default instead; exactly one workflow is always the default.`] }, 409);
  }
  await db.transaction(async (tx) => {
    if (input.isDefault === true && !wf.isDefault) {
      await tx.update(schema.workflows).set({ isDefault: false }).where(eq(schema.workflows.isDefault, true));
      patch.isDefault = true;
    }
    if (Object.keys(patch).length) await tx.update(schema.workflows).set(patch).where(eq(schema.workflows.id, id));
  });
  const parts: string[] = [];
  if (patch.name !== undefined && patch.name !== wf.name) parts.push(`renamed from "${wf.name}" to "${patch.name}"`);
  if (patch.description !== undefined && patch.description !== wf.description) parts.push('description changed');
  if (patch.isDefault) parts.push('made the default workflow');
  if (parts.length) await logWorkflowChange(id, c.get('user')?.id, { targetType: 'workflow', action: 'updated', summary: `Workflow ${parts.join(', ')}` });
  return c.json({ id, name: patch.name ?? wf.name, isDefault: input.isDefault === true || !!wf.isDefault });
});

app.delete('/rest/api/2/admin/workflow/:id', ...guard, async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ errorMessages: ['Invalid workflow id'] }, 400);
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).limit(1);
  if (!wf) return c.json({ errorMessages: ['Workflow not found'] }, 404);
  if (wf.isDefault) {
    return c.json({ errorMessages: [`"${wf.name}" is the default workflow. Projects without a workflow scheme use it, so it cannot be deleted.`] }, 409);
  }
  const usage = (await workflowUsage([id])).get(id)!;
  if (usage.schemes.length > 0) {
    // Count the issues that currently run on this workflow, for a concrete message.
    const issueTypeRows = await db.select({ schemeId: schema.workflowSchemeItems.schemeId, issueTypeId: schema.workflowSchemeItems.issueTypeId })
      .from(schema.workflowSchemeItems).where(eq(schema.workflowSchemeItems.workflowId, id));
    let issueCount = 0;
    for (const row of issueTypeRows) {
      const projs = await db.select({ projectId: schema.workflowSchemeAssociations.projectId }).from(schema.workflowSchemeAssociations)
        .where(eq(schema.workflowSchemeAssociations.schemeId, row.schemeId));
      if (!projs.length) continue;
      const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.issues).where(and(
        inArray(schema.issues.projectId, projs.map((p) => p.projectId)), eq(schema.issues.issueTypeId, row.issueTypeId)));
      issueCount += r?.n ?? 0;
    }
    const names = usage.schemes.map((s) => `"${s.name}"`).join(', ');
    return c.json({ errorMessages: [`"${wf.name}" is used by workflow scheme ${names}${issueCount ? ` (${issueCount} issue${issueCount === 1 ? '' : 's'} currently follow it)` : ''}. Remove it from the scheme first.`] }, 409);
  }
  await db.delete(schema.workflows).where(eq(schema.workflows.id, id));
  return c.json({});
});

app.put('/rest/api/2/admin/workflow/:id/layout', ...guard, body(z.object({ nodes: z.record(z.string(), z.unknown()) })), async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ errorMessages: ['Invalid workflow id'] }, 400);
  const { nodes } = c.req.valid('json');
  const err = validateLayout(nodes);
  if (err) return c.json({ errorMessages: [err] }, 400);
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).limit(1);
  if (!wf) return c.json({ errorMessages: ['Workflow not found'] }, 404);

  const ids = Object.keys(nodes).map(Number);
  if (ids.length) {
    const found = await db.select({ id: schema.statuses.id }).from(schema.statuses).where(inArray(schema.statuses.id, ids));
    const have = new Set(found.map((f) => f.id));
    const missing = ids.filter((i) => !have.has(i));
    if (missing.length) return c.json({ errorMessages: [`Unknown status id(s): ${missing.join(', ')}`] }, 400);
  }
  // Transition endpoints always belong to the workflow (see workflowStatusIds), so they need no entry here.
  const clean: Record<string, { x: number; y: number }> = {};
  for (const [k, v] of Object.entries(nodes)) clean[k] = { x: Math.round((v as any).x), y: Math.round((v as any).y) };
  await db.update(schema.workflows).set({ designerLayout: { nodes: clean } }).where(eq(schema.workflows.id, id));
  return c.json({ nodes: clean });
});

async function statusNames(ids: Array<number | null>): Promise<(id: number | null) => string> {
  const real = [...new Set(ids.filter((x): x is number => x !== null))];
  const rows = real.length ? await db.select({ id: schema.statuses.id, name: schema.statuses.name }).from(schema.statuses).where(inArray(schema.statuses.id, real)) : [];
  const m = new Map(rows.map((r) => [r.id, r.name]));
  return (id) => (id === null ? 'Any status' : m.get(id) ?? `#${id}`);
}

/** Who changed what in this workflow, newest first. */
app.get('/rest/api/2/admin/workflow/:id/history', ...guard, async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ errorMessages: ['Invalid workflow id'] }, 400);
  const [wf] = await db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.id, id)).limit(1);
  if (!wf) return c.json({ errorMessages: ['Workflow not found'] }, 404);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  return c.json({ entries: await listWorkflowChanges(id, limit, offset) });
});

/* ------------------------------------------------------------------ */
/*  Transitions                                                        */
/* ------------------------------------------------------------------ */

const transitionBase = {
  name: nameField,
  fromStatusId: z.number().int().positive().nullable(),
  toStatusId: z.number().int().positive(),
  screenId: z.number().int().positive().nullable(),
  conditions: itemList,
  validators: itemList,
  postFunctions: itemList,
};

app.post('/rest/api/2/admin/workflow/:id/transition', ...guard, body(z.object({
  ...transitionBase,
  fromStatusId: transitionBase.fromStatusId.default(null),
  screenId: transitionBase.screenId.default(null),
  conditions: transitionBase.conditions.default([]),
  validators: transitionBase.validators.default([]),
  postFunctions: transitionBase.postFunctions.default([]),
})), async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ errorMessages: ['Invalid workflow id'] }, 400);
  const input = c.req.valid('json');
  const [wf] = await db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.id, id)).limit(1);
  if (!wf) return c.json({ errorMessages: ['Workflow not found'] }, 404);
  const errors = await checkTransitionInput(id, input);
  if (errors.length) return c.json({ errorMessages: errors }, 400);
  const [t] = await db.insert(schema.workflowTransitions).values({
    workflowId: id, name: input.name, fromStatusId: input.fromStatusId, toStatusId: input.toStatusId, screenId: input.screenId,
    conditions: normalizeItems(input.conditions), validators: normalizeItems(input.validators), postFunctions: normalizeItems(input.postFunctions),
  }).returning();
  const names = await statusNames([input.fromStatusId, input.toStatusId]);
  const actor = c.get('user')?.id;
  await logWorkflowChange(id, actor, { targetType: 'transition', action: 'created', summary: `Transition "${t.name}" created (${names(input.fromStatusId)} -> ${names(input.toStatusId)})`, details: { transitionId: t.id } });
  await logWorkflowChanges(id, actor, [
    ...input.conditions.map((i) => ({ targetType: 'condition' as const, action: 'created' as const, summary: `Condition added on transition "${t.name}": ${describeItem(i)}`, details: { transition: t.name, item: i } })),
    ...input.validators.map((i) => ({ targetType: 'validator' as const, action: 'created' as const, summary: `Validator added on transition "${t.name}": ${describeItem(i)}`, details: { transition: t.name, item: i } })),
    ...input.postFunctions.map((i) => ({ targetType: 'postFunction' as const, action: 'created' as const, summary: `Post-function added on transition "${t.name}": ${describeItem(i)}`, details: { transition: t.name, item: i } })),
  ]);
  return c.json({ id: t.id }, 201);
});

app.put('/rest/api/2/admin/workflow/:id/transition/:tid', ...guard, body(z.object(transitionBase).partial()), async (c) => {
  const id = parseId(c.req.param('id'));
  const tid = parseId(c.req.param('tid'));
  if (id === null || tid === null) return c.json({ errorMessages: ['Invalid id'] }, 400);
  const input = c.req.valid('json');
  const [cur] = await db.select().from(schema.workflowTransitions)
    .where(and(eq(schema.workflowTransitions.id, tid), eq(schema.workflowTransitions.workflowId, id))).limit(1);
  if (!cur) return c.json({ errorMessages: ['Transition not found'] }, 404);
  const errors = await checkTransitionInput(id, input, tid, cur);
  if (errors.length) return c.json({ errorMessages: errors }, 400);
  const patch: Partial<typeof schema.workflowTransitions.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.fromStatusId !== undefined) patch.fromStatusId = input.fromStatusId;
  if (input.toStatusId !== undefined) patch.toStatusId = input.toStatusId;
  if (input.screenId !== undefined) patch.screenId = input.screenId;
  if (input.conditions !== undefined) patch.conditions = normalizeItems(input.conditions);
  if (input.validators !== undefined) patch.validators = normalizeItems(input.validators);
  if (input.postFunctions !== undefined) patch.postFunctions = normalizeItems(input.postFunctions);
  if (Object.keys(patch).length) await db.update(schema.workflowTransitions).set(patch).where(eq(schema.workflowTransitions.id, tid));
  const snap = (t: { name: string; fromStatusId: number | null; toStatusId: number; screenId: number | null; conditions: unknown; validators: unknown; postFunctions: unknown }): TransitionSnapshot => ({
    name: t.name, fromStatusId: t.fromStatusId, toStatusId: t.toStatusId, screenId: t.screenId,
    conditions: asList(t.conditions) as Record<string, unknown>[], validators: asList(t.validators) as Record<string, unknown>[], postFunctions: asList(t.postFunctions) as Record<string, unknown>[],
  });
  const after = snap({ ...cur, ...patch });
  const names = await statusNames([cur.fromStatusId, cur.toStatusId, after.fromStatusId, after.toStatusId]);
  await logWorkflowChanges(id, c.get('user')?.id, diffTransition(snap(cur), after, names));
  return c.json({ id: tid });
});

app.delete('/rest/api/2/admin/workflow/:id/transition/:tid', ...guard, async (c) => {
  const id = parseId(c.req.param('id'));
  const tid = parseId(c.req.param('tid'));
  if (id === null || tid === null) return c.json({ errorMessages: ['Invalid id'] }, 400);
  const deleted = await db.delete(schema.workflowTransitions)
    .where(and(eq(schema.workflowTransitions.id, tid), eq(schema.workflowTransitions.workflowId, id))).returning();
  if (!deleted.length) return c.json({ errorMessages: ['Transition not found'] }, 404);
  const names = await statusNames([deleted[0].fromStatusId, deleted[0].toStatusId]);
  await logWorkflowChange(id, c.get('user')?.id, { targetType: 'transition', action: 'deleted', summary: `Transition "${deleted[0].name}" deleted (${names(deleted[0].fromStatusId)} -> ${names(deleted[0].toStatusId)})` });
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Statuses                                                           */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/status', ...guard, async (c) => {
  const rows = await db.select().from(schema.statuses).orderBy(schema.statuses.sortOrder, schema.statuses.id);
  const issueCounts = await db.select({ statusId: schema.issues.statusId, n: sql<number>`count(*)::int` }).from(schema.issues).groupBy(schema.issues.statusId);
  const tr = await db.select({ f: schema.workflowTransitions.fromStatusId, t: schema.workflowTransitions.toStatusId }).from(schema.workflowTransitions);
  const issueMap = new Map(issueCounts.map((r) => [r.statusId, r.n]));
  const trMap = new Map<number, number>();
  for (const t of tr) { trMap.set(t.t, (trMap.get(t.t) ?? 0) + 1); if (t.f !== null && t.f !== t.t) trMap.set(t.f, (trMap.get(t.f) ?? 0) + 1); }
  return c.json({
    statuses: rows.map((s) => ({ ...serializeStatus(s), issueCount: issueMap.get(s.id) ?? 0, transitionCount: trMap.get(s.id) ?? 0 })),
  });
});

const statusFields = {
  name: z.string().trim().min(1, 'Name is required').max(100),
  description: z.string().max(1000).nullish(),
  category: z.enum(CATEGORIES),
  color: z.string().regex(HEX, 'Color must be a #RRGGBB hex value'),
  // false: no issue can be created directly into this status (workflow governance)
  allowNewIssues: z.boolean(),
};

async function statusNameTaken(name: string, exceptId?: number) {
  const rows = await db.select({ id: schema.statuses.id }).from(schema.statuses)
    .where(and(sql`lower(${schema.statuses.name}) = ${name.toLowerCase()}`, exceptId ? ne(schema.statuses.id, exceptId) : sql`true`)).limit(1);
  return rows.length > 0;
}

app.post('/rest/api/2/admin/status', ...guard, body(z.object({ ...statusFields, color: statusFields.color.optional(), allowNewIssues: statusFields.allowNewIssues.optional() })), async (c) => {
  const input = c.req.valid('json');
  if (await statusNameTaken(input.name)) return c.json({ errorMessages: [`A status named "${input.name}" already exists`] }, 409);
  const [max] = await db.select({ m: sql<number>`coalesce(max(${schema.statuses.sortOrder}), 0)::int` }).from(schema.statuses);
  const [s] = await db.insert(schema.statuses).values({
    name: input.name, description: input.description ?? null, category: input.category,
    color: input.color ?? CATEGORY_COLORS[input.category], sortOrder: (max?.m ?? 0) + 1, allowNewIssues: input.allowNewIssues ?? true,
  }).returning();
  return c.json(serializeStatus(s), 201);
});

app.put('/rest/api/2/admin/status/:id', ...guard, body(z.object(statusFields).partial()), async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ errorMessages: ['Invalid status id'] }, 400);
  const input = c.req.valid('json');
  const [cur] = await db.select().from(schema.statuses).where(eq(schema.statuses.id, id)).limit(1);
  if (!cur) return c.json({ errorMessages: ['Status not found'] }, 404);
  if (input.name !== undefined && (await statusNameTaken(input.name, id))) return c.json({ errorMessages: [`A status named "${input.name}" already exists`] }, 409);
  const patch: Partial<typeof schema.statuses.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.category !== undefined) patch.category = input.category;
  if (input.color !== undefined) patch.color = input.color;
  if (input.allowNewIssues !== undefined) patch.allowNewIssues = input.allowNewIssues;
  if (Object.keys(patch).length) await db.update(schema.statuses).set(patch).where(eq(schema.statuses.id, id));
  const changed: string[] = [];
  if (patch.name !== undefined && patch.name !== cur.name) changed.push(`renamed from "${cur.name}"`);
  if (patch.category !== undefined && patch.category !== cur.category) changed.push(`category ${cur.category} -> ${patch.category}`);
  if (patch.allowNewIssues !== undefined && patch.allowNewIssues !== (cur.allowNewIssues !== false)) changed.push(patch.allowNewIssues ? 'new issues allowed' : 'new issues no longer allowed');
  if (changed.length) {
    for (const wid of await workflowsUsingStatus(id)) {
      await logWorkflowChange(wid, c.get('user')?.id, { targetType: 'status', action: 'updated', summary: `Status "${patch.name ?? cur.name}": ${changed.join('; ')}`, details: { statusId: id } });
    }
  }
  const [s] = await db.select().from(schema.statuses).where(eq(schema.statuses.id, id)).limit(1);
  return c.json(serializeStatus(s));
});

app.delete('/rest/api/2/admin/status/:id', ...guard, async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ errorMessages: ['Invalid status id'] }, 400);
  const [cur] = await db.select().from(schema.statuses).where(eq(schema.statuses.id, id)).limit(1);
  if (!cur) return c.json({ errorMessages: ['Status not found'] }, 404);

  const [issues] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.issues).where(eq(schema.issues.statusId, id));
  if ((issues?.n ?? 0) > 0) return c.json({ errorMessages: [`"${cur.name}" is used by ${issues.n} issue${issues.n === 1 ? '' : 's'}. Move them to another status first.`], issueCount: issues.n }, 409);

  const tr = await db.select({ wf: schema.workflowTransitions.workflowId }).from(schema.workflowTransitions)
    .where(sql`${schema.workflowTransitions.fromStatusId} = ${id} or ${schema.workflowTransitions.toStatusId} = ${id}`);
  if (tr.length > 0) {
    const wfIds = [...new Set(tr.map((t) => t.wf))];
    const wfs = await db.select({ name: schema.workflows.name }).from(schema.workflows).where(inArray(schema.workflows.id, wfIds));
    return c.json({ errorMessages: [`"${cur.name}" is used by ${tr.length} transition${tr.length === 1 ? '' : 's'} in workflow ${wfs.map((w) => `"${w.name}"`).join(', ')}. Delete those transitions first.`] }, 409);
  }
  const [cols] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.boardColumns).where(eq(schema.boardColumns.statusId, id));
  if ((cols?.n ?? 0) > 0) return c.json({ errorMessages: [`"${cur.name}" is mapped to ${cols.n} board column${cols.n === 1 ? '' : 's'}. Unmap it first.`] }, 409);

  // Remove the status from workflow canvases so nothing dangles.
  const withLayout = await db.select({ id: schema.workflows.id, layout: schema.workflows.designerLayout }).from(schema.workflows);
  for (const w of withLayout) {
    const nodes = (w.layout as any)?.nodes ?? {};
    if (String(id) in nodes) {
      const { [String(id)]: _drop, ...rest } = nodes;
      await db.update(schema.workflows).set({ designerLayout: { nodes: rest } }).where(eq(schema.workflows.id, w.id));
    }
  }
  try {
    await db.delete(schema.statuses).where(eq(schema.statuses.id, id));
  } catch (err: any) {
    if (err?.code === '23503' || err?.cause?.code === '23503') return c.json({ errorMessages: [`"${cur.name}" is still referenced elsewhere and cannot be deleted.`] }, 409);
    throw err;
  }
  return c.json({});
});

export default app;
