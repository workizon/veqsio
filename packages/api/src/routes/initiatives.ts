import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { getBrowsableProjectIds, isAdminUser } from '../services/browse';
import { disabledFeatures } from '../features';
import { UPDATE_STATE_LABEL, statusUpdateBody, type UpdateState } from '../projects/status-updates';
import {
  INITIATIVE_STATUS_LABEL, canManageInitiative, canReadInitiative, initiativeCreateBody, initiativeLinkBody, initiativeUpdateBody,
  rollupProgress, trimToVisible, validateInitiativeDates, type InitiativeStatus, type RollupIssue,
} from '../initiatives/rollup';

/**
 * Initiatives (feature switch `initiatives`): workspace-level groupings of epics and projects.
 * Rules and the permission model are documented in initiatives/rollup.ts and docs/initiatives-and-milestones.md.
 *
 *   GET    /rest/api/2/initiatives                              the initiatives the caller may read, with progress
 *   POST   /rest/api/2/initiatives                              create (the creator becomes the owner)
 *   GET    /rest/api/2/initiatives/:id                          detail, linked epics/projects trimmed to what the caller can browse
 *   PUT    /rest/api/2/initiatives/:id                          owner or admin
 *   DELETE /rest/api/2/initiatives/:id                          owner or admin
 *   POST   /rest/api/2/initiatives/:id/links                    {projectKey} or {issueKey} (an epic), owner or admin
 *   DELETE /rest/api/2/initiatives/:id/projects/:projectKey     owner or admin
 *   DELETE /rest/api/2/initiatives/:id/epics/:issueKey          owner or admin
 *   GET|POST /rest/api/2/initiatives/:id/status-updates         health history (needs feature `updates`); posting: owner or admin
 *
 * An initiative the caller may not read is answered with 404, never 403.
 */
const app = new Hono<AppContext>();
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404);
const forbidden = (c: any) => c.json({ errorMessages: ['Forbidden'] }, 403);
type User = typeof schema.users.$inferSelect;
type InitiativeRow = typeof schema.initiatives.$inferSelect;
const iso = (d: Date | string | null) => (d ? (d instanceof Date ? d.toISOString() : String(d)) : null);

interface Ctx {
  user: User;
  isAdmin: boolean;
  visible: Set<number>;
}

async function ctxOf(user: User): Promise<Ctx> {
  return { user, isAdmin: await isAdminUser(user), visible: new Set(await getBrowsableProjectIds(user)) };
}

interface LinkedProject { id: number; projectId: number; key: string; name: string }
interface LinkedEpic { id: number; key: string; summary: string; projectId: number; projectKey: string; projectName: string; status: string }

async function loadLinks(initiativeIds: number[]) {
  const empty = { projects: new Map<number, LinkedProject[]>(), epics: new Map<number, LinkedEpic[]>() };
  if (!initiativeIds.length) return empty;
  const projectRows = await db.select({ initiativeId: schema.initiativeProjects.initiativeId, id: schema.projects.id, key: schema.projects.projectKey, name: schema.projects.name })
    .from(schema.initiativeProjects)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.initiativeProjects.projectId))
    .where(inArray(schema.initiativeProjects.initiativeId, initiativeIds));
  const epicRows = await db.select({
    initiativeId: schema.initiativeEpics.initiativeId, id: schema.issues.id, key: schema.issues.issueKey, summary: schema.issues.summary,
    projectId: schema.issues.projectId, projectKey: schema.projects.projectKey, projectName: schema.projects.name, status: schema.statuses.name,
  })
    .from(schema.initiativeEpics)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.initiativeEpics.issueId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.issues.projectId))
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .where(inArray(schema.initiativeEpics.initiativeId, initiativeIds));
  for (const r of projectRows) (empty.projects.get(r.initiativeId) ?? empty.projects.set(r.initiativeId, []).get(r.initiativeId)!).push({ id: r.id, projectId: r.id, key: r.key, name: r.name });
  for (const r of epicRows) (empty.epics.get(r.initiativeId) ?? empty.epics.set(r.initiativeId, []).get(r.initiativeId)!).push(r);
  return empty;
}

/** Issues feeding the rollup: the children of the epics plus the non-epic issues of the projects (visible ones only). */
async function loadRollupIssues(epics: LinkedEpic[], projects: LinkedProject[]) {
  const out: Array<RollupIssue & { parentId: number | null }> = [];
  if (epics.length) {
    const rows = await db.select({ id: schema.issues.id, projectId: schema.issues.projectId, parentId: schema.issues.parentId, category: schema.statuses.category })
      .from(schema.issues).innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
      .where(inArray(schema.issues.parentId, epics.map((e) => e.id)));
    out.push(...rows);
  }
  if (projects.length) {
    const rows = await db.select({ id: schema.issues.id, projectId: schema.issues.projectId, parentId: schema.issues.parentId, category: schema.statuses.category, type: schema.issueTypes.name })
      .from(schema.issues).innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
      .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
      .where(inArray(schema.issues.projectId, projects.map((p) => p.id)));
    out.push(...rows.filter((r) => r.type.toLowerCase() !== 'epic'));
  }
  return out;
}

async function usersById(ids: Array<number | null>) {
  const uniq = [...new Set(ids.filter((i): i is number => i !== null))];
  if (!uniq.length) return new Map<number, { id: number; displayName: string }>();
  const rows = await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, uniq));
  return new Map(rows.map((u) => [u.id, u]));
}

const serializeUpdate = (r: typeof schema.projectStatusUpdates.$inferSelect, author: { id: number; displayName: string } | null) => ({
  id: r.id, state: r.state, stateLabel: UPDATE_STATE_LABEL[r.state as UpdateState] ?? r.state, body: r.body,
  author: author ? { id: author.id, displayName: author.displayName } : null, created: r.createdAt.toISOString(),
});

async function latestUpdates(ids: number[]) {
  const out = new Map<number, ReturnType<typeof serializeUpdate>>();
  if (!ids.length) return out;
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (initiative_id) id, initiative_id, state, body, author_id, created_at
    FROM project_status_updates WHERE initiative_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    ORDER BY initiative_id, created_at DESC, id DESC`) as unknown as Array<{ id: number; initiative_id: number; state: string; body: string; author_id: number | null; created_at: Date | string }>;
  const who = await usersById(rows.map((r) => r.author_id));
  for (const r of rows) {
    out.set(r.initiative_id, serializeUpdate({ id: r.id, projectId: null, issueId: null, initiativeId: r.initiative_id, state: r.state, body: r.body, authorId: r.author_id, createdAt: new Date(r.created_at) }, r.author_id !== null ? who.get(r.author_id) ?? null : null));
  }
  return out;
}

/** The trimmed view of one initiative for one viewer; null when the viewer may not read it. */
async function viewOf(ctx: Ctx, row: InitiativeRow, links: Awaited<ReturnType<typeof loadLinks>>, detail: boolean) {
  const projects = trimToVisible(links.projects.get(row.id) ?? [], ctx.visible);
  const epics = trimToVisible(links.epics.get(row.id) ?? [], ctx.visible);
  const isOwner = row.ownerId === ctx.user.id;
  if (!canReadInitiative({ isAdmin: ctx.isAdmin, isOwner, visibleLinkCount: projects.length + epics.length })) return null;
  const issues = await loadRollupIssues(epics, projects);
  const progress = rollupProgress(issues, ctx.visible);
  const who = await usersById([row.ownerId]);
  const base = {
    id: row.id, name: row.name, description: row.description, status: row.status,
    statusLabel: INITIATIVE_STATUS_LABEL[row.status as InitiativeStatus] ?? row.status,
    startDate: row.startDate, targetDate: row.targetDate,
    owner: row.ownerId !== null ? who.get(row.ownerId) ?? null : null,
    canManage: canManageInitiative({ isAdmin: ctx.isAdmin, isOwner }),
    progress, projectCount: projects.length, epicCount: epics.length,
    created: iso(row.createdAt), updated: iso(row.updatedAt),
  };
  if (!detail) return base;
  return {
    ...base,
    projects: projects.map((p) => ({ key: p.key, name: p.name, progress: rollupProgress(issues.filter((i) => i.projectId === p.id), ctx.visible) })),
    epics: epics.map((e) => ({
      key: e.key, summary: e.summary, status: e.status, project: { key: e.projectKey, name: e.projectName },
      progress: rollupProgress(issues.filter((i) => i.parentId === e.id), ctx.visible),
    })),
  };
}

async function loadReadable(c: any, idParam = 'id') {
  const id = Number(c.req.param(idParam));
  const user = c.get('user')! as User;
  const [row] = await db.select().from(schema.initiatives).where(eq(schema.initiatives.id, id)).limit(1);
  if (!row) return null;
  const ctx = await ctxOf(user);
  const links = await loadLinks([row.id]);
  const projects = trimToVisible(links.projects.get(row.id) ?? [], ctx.visible);
  const epics = trimToVisible(links.epics.get(row.id) ?? [], ctx.visible);
  const isOwner = row.ownerId === user.id;
  if (!canReadInitiative({ isAdmin: ctx.isAdmin, isOwner, visibleLinkCount: projects.length + epics.length })) return null;
  return { row, ctx, links, isOwner, canManage: canManageInitiative({ isAdmin: ctx.isAdmin, isOwner }) };
}

async function ownerError(ownerId: number): Promise<string | null> {
  const [u] = await db.select({ id: schema.users.id, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, ownerId)).limit(1);
  return !u || u.active === false ? 'ownerId: unknown or inactive user' : null;
}

/* ---- list / create ---- */

app.get('/rest/api/2/initiatives', requireAuth, async (c) => {
  const ctx = await ctxOf(c.get('user')!);
  const rows = await db.select().from(schema.initiatives).orderBy(desc(schema.initiatives.createdAt), desc(schema.initiatives.id)).limit(500);
  const links = await loadLinks(rows.map((r) => r.id));
  const latest = await latestUpdates(rows.map((r) => r.id));
  const out = [];
  for (const row of rows) {
    const v = await viewOf(ctx, row, links, false);
    if (v) out.push({ ...v, health: latest.get(row.id) ?? null });
  }
  return c.json({ initiatives: out });
});

app.post('/rest/api/2/initiatives', requireAuth, async (c) => {
  const user = c.get('user')!;
  const parsed = initiativeCreateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ errorMessages: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) }, 400);
  const b = parsed.data;
  const dateErr = validateInitiativeDates(b.startDate, b.targetDate);
  if (dateErr) return c.json({ errorMessages: [dateErr] }, 400);
  const isAdmin = await isAdminUser(user);
  const ownerId = b.ownerId ?? user.id;
  if (ownerId !== user.id) {
    if (!isAdmin) return forbidden(c);
    const err = await ownerError(ownerId);
    if (err) return c.json({ errorMessages: [err] }, 400);
  }
  const [row] = await db.insert(schema.initiatives).values({
    name: b.name, description: b.description, ownerId, status: b.status, startDate: b.startDate ?? null, targetDate: b.targetDate ?? null, createdBy: user.id,
  }).returning();
  const ctx = await ctxOf(user);
  return c.json(await viewOf(ctx, row, await loadLinks([row.id]), true), 201);
});

/* ---- detail / update / delete ---- */

app.get('/rest/api/2/initiatives/:id', requireAuth, async (c) => {
  const found = await loadReadable(c);
  if (!found) return notFound(c);
  const view = await viewOf(found.ctx, found.row, found.links, true);
  const latest = await latestUpdates([found.row.id]);
  return c.json({ ...view, health: latest.get(found.row.id) ?? null });
});

app.put('/rest/api/2/initiatives/:id', requireAuth, async (c) => {
  const found = await loadReadable(c);
  if (!found) return notFound(c);
  if (!found.canManage) return forbidden(c);
  const parsed = initiativeUpdateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ errorMessages: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) }, 400);
  const b = parsed.data;
  const start = b.startDate !== undefined ? b.startDate : found.row.startDate;
  const target = b.targetDate !== undefined ? b.targetDate : found.row.targetDate;
  const dateErr = validateInitiativeDates(start, target);
  if (dateErr) return c.json({ errorMessages: [dateErr] }, 400);
  if (b.ownerId) {
    const err = await ownerError(b.ownerId);
    if (err) return c.json({ errorMessages: [err] }, 400);
  }
  const set: Partial<typeof schema.initiatives.$inferInsert> = { updatedAt: new Date() };
  if (b.name !== undefined) set.name = b.name;
  if (b.description !== undefined) set.description = b.description;
  if (b.ownerId !== undefined) set.ownerId = b.ownerId;
  if (b.status !== undefined) set.status = b.status;
  if (b.startDate !== undefined) set.startDate = b.startDate;
  if (b.targetDate !== undefined) set.targetDate = b.targetDate;
  const [row] = await db.update(schema.initiatives).set(set).where(eq(schema.initiatives.id, found.row.id)).returning();
  // the owner may have handed the initiative over: answer with what the caller can still see
  const view = await viewOf(found.ctx, row, await loadLinks([row.id]), true);
  return c.json(view ?? { id: row.id, name: row.name });
});

app.delete('/rest/api/2/initiatives/:id', requireAuth, async (c) => {
  const found = await loadReadable(c);
  if (!found) return notFound(c);
  if (!found.canManage) return forbidden(c);
  await db.delete(schema.initiatives).where(eq(schema.initiatives.id, found.row.id));
  return c.json({});
});

/* ---- links ---- */

app.post('/rest/api/2/initiatives/:id/links', requireAuth, async (c) => {
  const found = await loadReadable(c);
  if (!found) return notFound(c);
  if (!found.canManage) return forbidden(c);
  const parsed = initiativeLinkBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ errorMessages: parsed.error.issues.map((i) => i.message) }, 400);
  const { projectKey, issueKey } = parsed.data;
  if (projectKey) {
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, projectKey.toUpperCase())).limit(1);
    if (!p || !found.ctx.visible.has(p.id)) return notFound(c);
    const res = await db.insert(schema.initiativeProjects).values({ initiativeId: found.row.id, projectId: p.id }).onConflictDoNothing().returning();
    if (!res.length) return c.json({ errorMessages: ['Already linked'] }, 409);
  } else {
    const [row] = await db.select({ id: schema.issues.id, projectId: schema.issues.projectId, type: schema.issueTypes.name })
      .from(schema.issues).innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
      .where(eq(schema.issues.issueKey, issueKey!.toUpperCase())).limit(1);
    if (!row || !found.ctx.visible.has(row.projectId)) return notFound(c);
    if (row.type.toLowerCase() !== 'epic') return c.json({ errorMessages: ['Only epics can be linked; link the project to include all of its issues'] }, 400);
    const res = await db.insert(schema.initiativeEpics).values({ initiativeId: found.row.id, issueId: row.id }).onConflictDoNothing().returning();
    if (!res.length) return c.json({ errorMessages: ['Already linked'] }, 409);
  }
  await db.update(schema.initiatives).set({ updatedAt: new Date() }).where(eq(schema.initiatives.id, found.row.id));
  return c.json(await viewOf(found.ctx, found.row, await loadLinks([found.row.id]), true), 201);
});

app.delete('/rest/api/2/initiatives/:id/projects/:projectKey', requireAuth, async (c) => {
  const found = await loadReadable(c);
  if (!found) return notFound(c);
  if (!found.canManage) return forbidden(c);
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, c.req.param('projectKey').toUpperCase())).limit(1);
  if (!p) return notFound(c);
  // a link the caller cannot see looks like no link at all
  if (!found.ctx.isAdmin && !found.ctx.visible.has(p.id)) return notFound(c);
  const res = await db.delete(schema.initiativeProjects).where(and(eq(schema.initiativeProjects.initiativeId, found.row.id), eq(schema.initiativeProjects.projectId, p.id))).returning();
  return res.length ? c.json({}) : notFound(c);
});

app.delete('/rest/api/2/initiatives/:id/epics/:issueKey', requireAuth, async (c) => {
  const found = await loadReadable(c);
  if (!found) return notFound(c);
  if (!found.canManage) return forbidden(c);
  const [i] = await db.select({ id: schema.issues.id, projectId: schema.issues.projectId }).from(schema.issues).where(eq(schema.issues.issueKey, c.req.param('issueKey').toUpperCase())).limit(1);
  if (!i) return notFound(c);
  if (!found.ctx.isAdmin && !found.ctx.visible.has(i.projectId)) return notFound(c);
  const res = await db.delete(schema.initiativeEpics).where(and(eq(schema.initiativeEpics.initiativeId, found.row.id), eq(schema.initiativeEpics.issueId, i.id))).returning();
  return res.length ? c.json({}) : notFound(c);
});

/* ---- status updates (health) ---- */

const updatesOff = async () => (await disabledFeatures()).has('updates');

app.get('/rest/api/2/initiatives/:id/status-updates', requireAuth, async (c) => {
  const found = await loadReadable(c);
  if (!found || (await updatesOff())) return notFound(c);
  const rows = await db.select().from(schema.projectStatusUpdates).where(eq(schema.projectStatusUpdates.initiativeId, found.row.id))
    .orderBy(desc(schema.projectStatusUpdates.createdAt), desc(schema.projectStatusUpdates.id)).limit(100);
  const who = await usersById(rows.map((r) => r.authorId));
  const updates = rows.map((r) => serializeUpdate(r, r.authorId !== null ? who.get(r.authorId) ?? null : null));
  return c.json({ updates, latest: updates[0] ?? null });
});

app.post('/rest/api/2/initiatives/:id/status-updates', requireAuth, async (c) => {
  const found = await loadReadable(c);
  if (!found || (await updatesOff())) return notFound(c);
  if (!found.canManage) return forbidden(c);
  const parsed = statusUpdateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ errorMessages: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) }, 400);
  const user = c.get('user')!;
  const [row] = await db.insert(schema.projectStatusUpdates).values({ initiativeId: found.row.id, state: parsed.data.state, body: parsed.data.body, authorId: user.id }).returning();
  return c.json(serializeUpdate(row, { id: user.id, displayName: user.displayName }), 201);
});

export default app;
