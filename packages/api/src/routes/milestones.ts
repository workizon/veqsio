import { Hono } from 'hono';
import { and, asc, eq, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { checkProjectPermission } from '../middleware/permissions';
import {
  isOverdue, issueMilestonesBody, issuesOutsideProject, milestoneCreateBody, milestoneIssueBody, milestoneProgress, milestoneUpdateBody,
} from '../milestones/rules';

/**
 * Milestones (feature switch `milestones`, switchable per project).
 *
 *   GET    /rest/api/2/project/:key/milestones                         list with progress (BROWSE_PROJECTS; 404 otherwise)
 *   POST   /rest/api/2/project/:key/milestones                         {name, description?, targetDate?} (PROJECT_ADMIN)
 *   GET    /rest/api/2/project/:key/milestones/:id                     detail with the linked issues
 *   PUT    /rest/api/2/project/:key/milestones/:id                     {name?, description?, targetDate?, state?} (PROJECT_ADMIN)
 *   DELETE /rest/api/2/project/:key/milestones/:id                     (PROJECT_ADMIN)
 *   POST   /rest/api/2/project/:key/milestones/:id/issues              {issueKey} (EDIT_ISSUES; the issue must be in the same project)
 *   DELETE /rest/api/2/project/:key/milestones/:id/issues/:issueKey    (EDIT_ISSUES)
 *   GET    /rest/api/2/issue/:idOrKey/milestones                       the milestones of an issue (BROWSE_PROJECTS)
 *   PUT    /rest/api/2/issue/:idOrKey/milestones                       {milestoneIds} replaces the set (EDIT_ISSUES; same project)
 */
const app = new Hono<AppContext>();
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404);
const forbidden = (c: any) => c.json({ errorMessages: ['Forbidden'] }, 403);
const bad = (c: any, msgs: string[]) => c.json({ errorMessages: msgs }, 400);
type Milestone = typeof schema.milestones.$inferSelect;
const today = () => new Date().toISOString().slice(0, 10);

async function loadProject(c: any) {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, c.req.param('key').toUpperCase())).limit(1);
  if (!p || !(await checkProjectPermission(c.get('user')!, p.id, 'BROWSE_PROJECTS'))) return null;
  return p;
}

async function loadMilestone(c: any) {
  const project = await loadProject(c);
  if (!project) return null;
  const [m] = await db.select().from(schema.milestones).where(and(eq(schema.milestones.id, Number(c.req.param('id'))), eq(schema.milestones.projectId, project.id))).limit(1);
  return m ? { project, milestone: m } : null;
}

async function issuesOf(milestoneIds: number[]) {
  if (!milestoneIds.length) return [];
  return db.select({
    milestoneId: schema.milestoneIssues.milestoneId, key: schema.issues.issueKey, summary: schema.issues.summary, type: schema.issueTypes.name,
    status: schema.statuses.name, category: schema.statuses.category,
  })
    .from(schema.milestoneIssues)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.milestoneIssues.issueId))
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .where(inArray(schema.milestoneIssues.milestoneId, milestoneIds))
    .orderBy(asc(schema.issues.id));
}

const serialize = (m: Milestone, issues: Awaited<ReturnType<typeof issuesOf>>, detail: boolean) => ({
  id: m.id, name: m.name, description: m.description, targetDate: m.targetDate, state: m.state,
  reachedAt: m.reachedAt ? m.reachedAt.toISOString() : null,
  overdue: isOverdue({ state: m.state, targetDate: m.targetDate }, today()),
  progress: milestoneProgress(issues),
  ...(detail ? { issues: issues.map((i) => ({ key: i.key, summary: i.summary, type: i.type, status: i.status, statusCategory: i.category })) } : {}),
});

async function view(m: Milestone, detail: boolean) {
  return serialize(m, await issuesOf([m.id]), detail);
}

const uniqueName = (c: any) => c.json({ errorMessages: ['A milestone with this name already exists in the project'] }, 409);

app.get('/rest/api/2/project/:key/milestones', requireAuth, async (c) => {
  const project = await loadProject(c);
  if (!project) return notFound(c);
  const rows = await db.select().from(schema.milestones).where(eq(schema.milestones.projectId, project.id)).orderBy(asc(schema.milestones.targetDate), asc(schema.milestones.id));
  const issues = await issuesOf(rows.map((r) => r.id));
  const canManage = await checkProjectPermission(c.get('user')!, project.id, 'PROJECT_ADMIN');
  return c.json({ milestones: rows.map((m) => serialize(m, issues.filter((i) => i.milestoneId === m.id), false)), canManage });
});

app.post('/rest/api/2/project/:key/milestones', requireAuth, async (c) => {
  const project = await loadProject(c);
  if (!project) return notFound(c);
  if (!(await checkProjectPermission(c.get('user')!, project.id, 'PROJECT_ADMIN'))) return forbidden(c);
  const parsed = milestoneCreateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
  const b = parsed.data;
  const [dup] = await db.select({ id: schema.milestones.id }).from(schema.milestones).where(and(eq(schema.milestones.projectId, project.id), eq(schema.milestones.name, b.name))).limit(1);
  if (dup) return uniqueName(c);
  const [m] = await db.insert(schema.milestones).values({ projectId: project.id, name: b.name, description: b.description, targetDate: b.targetDate ?? null, createdBy: c.get('user')!.id }).returning();
  return c.json(await view(m, true), 201);
});

app.get('/rest/api/2/project/:key/milestones/:id', requireAuth, async (c) => {
  const found = await loadMilestone(c);
  if (!found) return notFound(c);
  return c.json(await view(found.milestone, true));
});

app.put('/rest/api/2/project/:key/milestones/:id', requireAuth, async (c) => {
  const found = await loadMilestone(c);
  if (!found) return notFound(c);
  if (!(await checkProjectPermission(c.get('user')!, found.project.id, 'PROJECT_ADMIN'))) return forbidden(c);
  const parsed = milestoneUpdateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
  const b = parsed.data;
  const set: Partial<typeof schema.milestones.$inferInsert> = {};
  if (b.name !== undefined && b.name !== found.milestone.name) {
    const [dup] = await db.select({ id: schema.milestones.id }).from(schema.milestones).where(and(eq(schema.milestones.projectId, found.project.id), eq(schema.milestones.name, b.name))).limit(1);
    if (dup) return uniqueName(c);
    set.name = b.name;
  }
  if (b.description !== undefined) set.description = b.description;
  if (b.targetDate !== undefined) set.targetDate = b.targetDate;
  if (b.state !== undefined && b.state !== found.milestone.state) {
    set.state = b.state;
    set.reachedAt = b.state === 'reached' ? new Date() : null;
  }
  const [m] = Object.keys(set).length
    ? await db.update(schema.milestones).set(set).where(eq(schema.milestones.id, found.milestone.id)).returning()
    : [found.milestone];
  return c.json(await view(m, true));
});

app.delete('/rest/api/2/project/:key/milestones/:id', requireAuth, async (c) => {
  const found = await loadMilestone(c);
  if (!found) return notFound(c);
  if (!(await checkProjectPermission(c.get('user')!, found.project.id, 'PROJECT_ADMIN'))) return forbidden(c);
  await db.delete(schema.milestones).where(eq(schema.milestones.id, found.milestone.id));
  return c.json({});
});

/* ---- linked issues ---- */

app.post('/rest/api/2/project/:key/milestones/:id/issues', requireAuth, async (c) => {
  const found = await loadMilestone(c);
  if (!found) return notFound(c);
  if (!(await checkProjectPermission(c.get('user')!, found.project.id, 'EDIT_ISSUES'))) return forbidden(c);
  const parsed = milestoneIssueBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
  const [issue] = await db.select({ id: schema.issues.id, key: schema.issues.issueKey, projectId: schema.issues.projectId }).from(schema.issues)
    .where(eq(schema.issues.issueKey, parsed.data.issueKey.toUpperCase())).limit(1);
  // an issue of a project the caller cannot browse does not exist for them
  if (!issue || (issue.projectId !== found.project.id && !(await checkProjectPermission(c.get('user')!, issue.projectId, 'BROWSE_PROJECTS')))) return notFound(c);
  if (issuesOutsideProject([issue], found.project.id).length) return bad(c, [`${issue.key} is not in project ${found.project.projectKey}; a milestone only holds issues of its own project`]);
  await db.insert(schema.milestoneIssues).values({ milestoneId: found.milestone.id, issueId: issue.id }).onConflictDoNothing();
  return c.json(await view(found.milestone, true), 201);
});

app.delete('/rest/api/2/project/:key/milestones/:id/issues/:issueKey', requireAuth, async (c) => {
  const found = await loadMilestone(c);
  if (!found) return notFound(c);
  if (!(await checkProjectPermission(c.get('user')!, found.project.id, 'EDIT_ISSUES'))) return forbidden(c);
  const [issue] = await db.select({ id: schema.issues.id }).from(schema.issues)
    .where(and(eq(schema.issues.issueKey, c.req.param('issueKey').toUpperCase()), eq(schema.issues.projectId, found.project.id))).limit(1);
  if (!issue) return notFound(c);
  const res = await db.delete(schema.milestoneIssues).where(and(eq(schema.milestoneIssues.milestoneId, found.milestone.id), eq(schema.milestoneIssues.issueId, issue.id))).returning();
  return res.length ? c.json({}) : notFound(c);
});

/* ---- milestones of one issue (issue sidebar) ---- */

async function loadIssue(c: any) {
  const idOrKey = c.req.param('idOrKey');
  const where = /^\d{1,9}$/.test(idOrKey) ? eq(schema.issues.id, Number(idOrKey)) : eq(schema.issues.issueKey, idOrKey.toUpperCase());
  const [issue] = await db.select({ id: schema.issues.id, key: schema.issues.issueKey, projectId: schema.issues.projectId }).from(schema.issues).where(where).limit(1);
  if (!issue || !(await checkProjectPermission(c.get('user')!, issue.projectId, 'BROWSE_PROJECTS'))) return null;
  return issue;
}

async function milestonesOfIssue(issueId: number) {
  return db.select({ id: schema.milestones.id, name: schema.milestones.name, state: schema.milestones.state, targetDate: schema.milestones.targetDate })
    .from(schema.milestoneIssues).innerJoin(schema.milestones, eq(schema.milestones.id, schema.milestoneIssues.milestoneId))
    .where(eq(schema.milestoneIssues.issueId, issueId)).orderBy(asc(schema.milestones.targetDate), asc(schema.milestones.id));
}

app.get('/rest/api/2/issue/:idOrKey/milestones', requireAuth, async (c) => {
  const issue = await loadIssue(c);
  if (!issue) return notFound(c);
  return c.json({ milestones: await milestonesOfIssue(issue.id) });
});

app.put('/rest/api/2/issue/:idOrKey/milestones', requireAuth, async (c) => {
  const issue = await loadIssue(c);
  if (!issue) return notFound(c);
  if (!(await checkProjectPermission(c.get('user')!, issue.projectId, 'EDIT_ISSUES'))) return forbidden(c);
  const parsed = issueMilestonesBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
  const ids = [...new Set(parsed.data.milestoneIds)];
  if (ids.length) {
    const rows = await db.select({ id: schema.milestones.id, projectId: schema.milestones.projectId }).from(schema.milestones).where(inArray(schema.milestones.id, ids));
    const known = new Map(rows.map((r) => [r.id, r.projectId]));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) return bad(c, [`Unknown milestone: ${unknown.join(', ')}`]);
    const foreign = ids.filter((id) => known.get(id) !== issue.projectId);
    if (foreign.length) return bad(c, [`Milestone ${foreign.join(', ')} belongs to another project; an issue can only be in milestones of its own project`]);
  }
  await db.transaction(async (tx) => {
    await tx.delete(schema.milestoneIssues).where(eq(schema.milestoneIssues.issueId, issue.id));
    if (ids.length) await tx.insert(schema.milestoneIssues).values(ids.map((milestoneId) => ({ milestoneId, issueId: issue.id })));
  });
  return c.json({ milestones: await milestonesOfIssue(issue.id) });
});

export default app;
