import { Hono } from 'hono';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { checkProjectPermission } from '../middleware/permissions';
import { getBrowsableProjectIds } from '../services/browse';
import { queueEmails } from '../services/email';
import { projectDisabledFeatures } from '../features';
import { UPDATE_STATE_LABEL, statusUpdateBody, type UpdateState } from '../projects/status-updates';

/**
 * Status updates on projects and epics (feature switch `updates`).
 *
 *   GET  /rest/api/2/project/:key/status-updates      history, newest first (BROWSE_PROJECTS; 404 otherwise)
 *   POST /rest/api/2/project/:key/status-updates      {state, body?} (EDIT_ISSUES)
 *   GET  /rest/api/2/issue/:idOrKey/status-updates    same for an epic
 *   POST /rest/api/2/issue/:idOrKey/status-updates
 *   GET  /rest/api/2/status-updates/latest            the current state of every browsable project (projects list badge)
 */
const app = new Hono<AppContext>();
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404);
const LIST_LIMIT = 100;

type Target = { projectId: number; projectKey: string; projectName: string; leadId: number | null; issue: { id: number; key: string; summary: string; assigneeId: number | null; isEpic: boolean } | null };

async function loadProjectTarget(key: string): Promise<Target | null> {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key.toUpperCase())).limit(1);
  return p ? { projectId: p.id, projectKey: p.projectKey, projectName: p.name, leadId: p.leadId, issue: null } : null;
}

async function loadIssueTarget(idOrKey: string): Promise<Target | null> {
  const where = /^\d+$/.test(idOrKey) ? eq(schema.issues.id, Number(idOrKey)) : eq(schema.issues.issueKey, idOrKey.toUpperCase());
  const [row] = await db.select({ issue: schema.issues, type: schema.issueTypes.name, project: schema.projects })
    .from(schema.issues)
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.issues.projectId))
    .where(where).limit(1);
  if (!row) return null;
  return {
    projectId: row.project.id, projectKey: row.project.projectKey, projectName: row.project.name, leadId: row.project.leadId,
    issue: { id: row.issue.id, key: row.issue.issueKey, summary: row.issue.summary, assigneeId: row.issue.assigneeId, isEpic: row.type.toLowerCase() === 'epic' },
  };
}

const serialize = (r: typeof schema.projectStatusUpdates.$inferSelect, author: { id: number; displayName: string } | null) => ({
  id: r.id,
  state: r.state,
  stateLabel: UPDATE_STATE_LABEL[r.state as UpdateState] ?? r.state,
  body: r.body,
  author: author ? { id: author.id, displayName: author.displayName } : null,
  created: r.createdAt.toISOString(),
});

async function authors(ids: Array<number | null>) {
  const uniq = [...new Set(ids.filter((i): i is number => i !== null))];
  if (!uniq.length) return new Map<number, { id: number; displayName: string }>();
  const rows = await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, uniq));
  return new Map(rows.map((u) => [u.id, u]));
}

async function list(target: Target) {
  const where = target.issue
    ? eq(schema.projectStatusUpdates.issueId, target.issue.id)
    : and(eq(schema.projectStatusUpdates.projectId, target.projectId), isNull(schema.projectStatusUpdates.issueId));
  const rows = await db.select().from(schema.projectStatusUpdates).where(where)
    .orderBy(desc(schema.projectStatusUpdates.createdAt), desc(schema.projectStatusUpdates.id)).limit(LIST_LIMIT);
  const who = await authors(rows.map((r) => r.authorId));
  const updates = rows.map((r) => serialize(r, r.authorId !== null ? who.get(r.authorId) ?? null : null));
  return { updates, latest: updates[0] ?? null };
}

async function post(c: any, target: Target) {
  const user = c.get('user')!;
  if (!(await checkProjectPermission(user, target.projectId, 'BROWSE_PROJECTS'))) return notFound(c);
  if (!(await checkProjectPermission(user, target.projectId, 'EDIT_ISSUES'))) return c.json({ errorMessages: ['Forbidden'] }, 403);
  if (target.issue && !target.issue.isEpic) return c.json({ errorMessages: ['Status updates can only be posted on projects and epics'] }, 400);
  const parsed = statusUpdateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ errorMessages: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) }, 400);
  }
  const [row] = await db.insert(schema.projectStatusUpdates).values({
    projectId: target.projectId, issueId: target.issue?.id ?? null, state: parsed.data.state, body: parsed.data.body, authorId: user.id,
  }).returning();
  void notifyWatchers(target, row, user).catch((e) => console.error('[status-updates] notification failed', e));
  return c.json(serialize(row, { id: user.id, displayName: user.displayName }), 201);
}

/** E-mail (module notice) to the project lead and, for epics, the assignee and watchers; only people who can browse the project, never the author. */
async function notifyWatchers(target: Target, row: typeof schema.projectStatusUpdates.$inferSelect, author: { id: number; displayName: string }) {
  const ids = new Set<number>();
  if (target.leadId) ids.add(target.leadId);
  if (target.issue) {
    if (target.issue.assigneeId) ids.add(target.issue.assigneeId);
    for (const w of await db.select({ u: schema.watchers.userId }).from(schema.watchers).where(eq(schema.watchers.issueId, target.issue.id))) ids.add(w.u);
  }
  ids.delete(author.id);
  if (!ids.size) return;
  const users = await db.select().from(schema.users).where(and(inArray(schema.users.id, [...ids]), eq(schema.users.active, true)));
  const to: string[] = [];
  for (const u of users) if (await checkProjectPermission(u as any, target.projectId, 'BROWSE_PROJECTS')) to.push(u.email);
  if (!to.length) return;
  const base = process.env.WEB_URL || 'http://localhost:3001';
  const label = UPDATE_STATE_LABEL[row.state as UpdateState] ?? row.state;
  const what = target.issue ? `${target.issue.key} ${target.issue.summary}` : target.projectName;
  await queueEmails(to, 'module-notice', {
    subject: `${label}: ${what}`.replace(/[\r\n]+/g, " "),
    heading: `${author.displayName} posted a status update: ${label}`,
    lines: row.body ? [row.body.slice(0, 2000)] : [],
    ...(target.issue ? { issueKey: target.issue.key, summary: target.issue.summary } : {}),
    url: target.issue ? `${base}/issues/${target.issue.key}` : `${base}/projects/${target.projectKey}`,
    actionLabel: 'Open',
  });
}

/* ---- project ---- */

app.get('/rest/api/2/project/:key/status-updates', requireAuth, async (c) => {
  const target = await loadProjectTarget(c.req.param('key'));
  if (!target || !(await checkProjectPermission(c.get('user')!, target.projectId, 'BROWSE_PROJECTS'))) return notFound(c);
  return c.json(await list(target));
});

app.post('/rest/api/2/project/:key/status-updates', requireAuth, async (c) => {
  const target = await loadProjectTarget(c.req.param('key'));
  if (!target) return notFound(c);
  return post(c, target);
});

/* ---- epic ---- */

app.get('/rest/api/2/issue/:idOrKey/status-updates', requireAuth, async (c) => {
  const target = await loadIssueTarget(c.req.param('idOrKey'));
  if (!target || !(await checkProjectPermission(c.get('user')!, target.projectId, 'BROWSE_PROJECTS'))) return notFound(c);
  return c.json(await list(target));
});

app.post('/rest/api/2/issue/:idOrKey/status-updates', requireAuth, async (c) => {
  const target = await loadIssueTarget(c.req.param('idOrKey'));
  if (!target) return notFound(c);
  return post(c, target);
});

/* ---- current state of all browsable projects ---- */

app.get('/rest/api/2/status-updates/latest', requireAuth, async (c) => {
  const browsable = await getBrowsableProjectIds(c.get('user')!);
  if (!browsable.length) return c.json({ latest: {} });
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (u.project_id) u.id, u.project_id, u.state, u.body, u.author_id, u.created_at, p.project_key
    FROM project_status_updates u JOIN projects p ON p.id = u.project_id
    WHERE u.issue_id IS NULL AND u.project_id IN (${sql.join(browsable.map((id) => sql`${id}`), sql`, `)})
    ORDER BY u.project_id, u.created_at DESC, u.id DESC`) as unknown as Array<{ id: number; project_id: number; state: string; body: string; author_id: number | null; created_at: Date | string; project_key: string }>;
  const who = await authors(rows.map((r) => r.author_id));
  const latest: Record<string, ReturnType<typeof serialize>> = {};
  for (const r of rows) {
    // a project that switched the feature off keeps its data but shows no badge
    if ((await projectDisabledFeatures(r.project_key)).has('updates')) continue;
    latest[r.project_key] = serialize({
      id: r.id, projectId: r.project_id, issueId: null, initiativeId: null, state: r.state, body: r.body, authorId: r.author_id, createdAt: new Date(r.created_at),
    }, r.author_id !== null ? who.get(r.author_id) ?? null : null);
  }
  return c.json({ latest });
});

export default app;
