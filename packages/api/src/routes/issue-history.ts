import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireIssueAccess, checkProjectPermission, checkGlobalPermission } from '../middleware/permissions';
import { isAdminUser } from '../services/browse';
import { updateIssue } from '../issues/service';
import { invalidateIssueCache } from '../middleware/cache';
import { publishIssue } from '../realtime/publish';
import { getIssue } from '../issues/service';
import { reportCategory } from '../workflow/status-groups';
import { getWorkflowGovernance, logWorkflowChange } from '../workflow/governance';
import { recordAudit } from '../audit/log';
import { computeTimeInStatus, averageTimeInStatus, type TimeInStatus } from '../history/time-in-status';
import { buildDescriptionVersions } from '../history/description';
import { applyTypeChange, planTypeChange, TypeChangeError } from '../history/change-type';
import { diffLines, summarizeDiff } from '../pages/diff';

/**
 * Issue history depth:
 *   GET  /rest/api/2/issue/:key/time-in-status
 *   GET  /rest/api/2/reports/time-in-status?project=KEY | boardId=N | sprintId=N
 *   GET  /rest/api/2/issue/:key/description-history[/:version]
 *   POST /rest/api/2/issue/:key/description-history/:version/restore
 *   POST /rest/api/2/issue/:key/change-type[?preview=true]
 *   GET|PUT /rest/api/2/project/:key/workflow-scheme
 */
const app = new Hono<AppContext>();

const MAX_REPORT_ISSUES = 5000;
const bad = (c: any, msg: string, status = 400) => c.json({ errorMessages: [msg] }, status);

async function categoryLookup() {
  const rows = await db.select().from(schema.statuses);
  const m = new Map(rows.map((s) => [s.name, reportCategory(s.category) as string]));
  return (name: string) => m.get(name) ?? 'todo';
}

/* ---------------------------- time in status ---------------------------- */

async function loadTimeInStatus(issues: Array<typeof schema.issues.$inferSelect>): Promise<Map<number, TimeInStatus>> {
  const out = new Map<number, TimeInStatus>();
  if (issues.length === 0) return out;
  const ids = issues.map((i) => i.id);
  const [history, statuses, categoryOf] = await Promise.all([
    db.select().from(schema.issueHistory).where(and(inArray(schema.issueHistory.issueId, ids), eq(schema.issueHistory.fieldName, 'status'))).orderBy(asc(schema.issueHistory.createdAt), asc(schema.issueHistory.id)),
    db.select().from(schema.statuses),
    categoryLookup(),
  ]);
  const statusName = new Map(statuses.map((s) => [s.id, s.name]));
  const byIssue = new Map<number, typeof history>();
  for (const h of history) (byIssue.get(h.issueId) ?? byIssue.set(h.issueId, []).get(h.issueId)!).push(h);
  const now = new Date();
  for (const i of issues) {
    out.set(i.id, computeTimeInStatus({
      createdAt: i.createdAt ?? now, creatorId: i.reporterId, currentStatus: statusName.get(i.statusId) ?? 'To Do', now, categoryOf,
      changes: (byIssue.get(i.id) ?? []).map((h) => ({ at: h.createdAt ?? now, from: h.oldValue, to: h.newValue, by: h.authorId })),
    }));
  }
  return out;
}

async function userNames(ids: Array<number | null>) {
  const real = [...new Set(ids.filter((x): x is number => !!x))];
  const rows = real.length ? await db.select({ id: schema.users.id, name: schema.users.displayName, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, real)) : [];
  return new Map(rows.map((u) => [u.id, { id: u.id, displayName: u.name || u.username }]));
}

app.get('/rest/api/2/issue/:key/time-in-status', requireAuth, requireIssueAccess('BROWSE_PROJECTS'), async (c) => {
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, c.req.param('key'))).limit(1);
  if (!issue) return bad(c, 'Issue not found', 404);
  const t = (await loadTimeInStatus([issue])).get(issue.id)!;
  const users = await userNames(t.segments.map((s) => s.movedBy));
  return c.json({
    issueKey: issue.issueKey,
    totalMs: t.totalMs,
    byStatus: t.byStatus,
    byCategory: t.byCategory,
    segments: t.segments.map((s) => ({
      status: s.status, category: s.category, enteredAt: s.enteredAt.toISOString(), leftAt: s.leftAt?.toISOString() ?? null,
      durationMs: s.durationMs, movedBy: s.movedBy ? users.get(s.movedBy) ?? { id: s.movedBy, displayName: 'Unknown' } : null,
    })),
  });
});

app.get('/rest/api/2/reports/time-in-status', requireAuth, async (c) => {
  const user = c.get('user')!;
  const projectKey = c.req.query('project');
  const boardId = c.req.query('boardId');
  const sprintId = c.req.query('sprintId');
  const given = [projectKey, boardId, sprintId].filter((x) => x !== undefined && x !== '').length;
  if (given !== 1) return bad(c, 'Give exactly one of project, boardId or sprintId');

  let projectId: number | null = null;
  let issueIds: number[] | null = null; // null = whole project
  let scope: { type: string; id: number | string; name: string } | null = null;
  if (projectKey) {
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, projectKey.toUpperCase())).limit(1);
    if (p) { projectId = p.id; scope = { type: 'project', id: p.projectKey, name: p.name }; }
  } else if (boardId) {
    if (!/^\d+$/.test(boardId)) return bad(c, 'Not found', 404);
    const [b] = await db.select().from(schema.boards).where(eq(schema.boards.id, Number(boardId))).limit(1);
    if (b) { projectId = b.projectId; scope = { type: 'board', id: b.id, name: b.name }; }
  } else if (sprintId) {
    if (!/^\d+$/.test(sprintId)) return bad(c, 'Not found', 404);
    const [s] = await db.select().from(schema.sprints).where(eq(schema.sprints.id, Number(sprintId))).limit(1);
    if (s) {
      const [b] = await db.select().from(schema.boards).where(eq(schema.boards.id, s.boardId)).limit(1);
      if (b) {
        projectId = b.projectId; scope = { type: 'sprint', id: s.id, name: s.name };
        issueIds = (await db.select({ id: schema.sprintIssues.issueId }).from(schema.sprintIssues).where(eq(schema.sprintIssues.sprintId, s.id))).map((r) => r.id);
      }
    }
  }
  // Browse trimming: a project the caller cannot browse does not exist for them.
  if (projectId === null || !scope || !(await checkProjectPermission(user, projectId, 'BROWSE_PROJECTS'))) return bad(c, 'Not found', 404);

  let issues: Array<typeof schema.issues.$inferSelect> = [];
  if (issueIds === null) {
    issues = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId)).orderBy(desc(schema.issues.id)).limit(MAX_REPORT_ISSUES);
  } else if (issueIds.length) {
    issues = await db.select().from(schema.issues).where(and(inArray(schema.issues.id, issueIds), eq(schema.issues.projectId, projectId))).limit(MAX_REPORT_ISSUES);
  }
  const per = await loadTimeInStatus(issues);
  const all = [...per.values()];
  const byCategory = new Map<string, { sum: number; n: number }>();
  for (const t of all) for (const cat of t.byCategory) {
    const e = byCategory.get(cat.category) ?? { sum: 0, n: 0 };
    e.sum += cat.durationMs; e.n += 1; byCategory.set(cat.category, e);
  }
  return c.json({
    scope,
    issueCount: issues.length,
    truncated: issues.length >= MAX_REPORT_ISSUES,
    statuses: averageTimeInStatus(all),
    categories: [...byCategory].map(([category, e]) => ({ category, issues: e.n, totalMs: e.sum, avgMs: Math.round(e.sum / e.n) })),
  });
});

/* -------------------------- description versions ------------------------- */

async function descriptionVersions(issue: typeof schema.issues.$inferSelect) {
  const rows = await db.select().from(schema.issueHistory)
    .where(and(eq(schema.issueHistory.issueId, issue.id), eq(schema.issueHistory.fieldName, 'description')))
    .orderBy(asc(schema.issueHistory.createdAt), asc(schema.issueHistory.id));
  return buildDescriptionVersions({
    createdAt: issue.createdAt, creatorId: issue.reporterId,
    changes: rows.map((r) => ({ id: r.id, at: r.createdAt ?? new Date(0), from: r.oldValue, to: r.newValue, by: r.authorId })),
  });
}

app.get('/rest/api/2/issue/:key/description-history', requireAuth, requireIssueAccess('BROWSE_PROJECTS'), async (c) => {
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, c.req.param('key'))).limit(1);
  if (!issue) return bad(c, 'Issue not found', 404);
  const versions = await descriptionVersions(issue);
  const users = await userNames(versions.map((v) => v.authorId));
  return c.json({
    issueKey: issue.issueKey,
    versions: versions.map((v, i) => {
      const s = summarizeDiff(diffLines(i > 0 ? versions[i - 1].text : '', v.text));
      return {
        version: v.version, createdAt: v.createdAt?.toISOString() ?? null, current: v.current,
        author: v.authorId ? users.get(v.authorId) ?? null : null,
        length: v.text.length, added: i === 0 ? null : s.added, removed: i === 0 ? null : s.removed,
      };
    }).reverse(),
  });
});

app.get('/rest/api/2/issue/:key/description-history/:version', requireAuth, requireIssueAccess('BROWSE_PROJECTS'), async (c) => {
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, c.req.param('key'))).limit(1);
  if (!issue) return bad(c, 'Issue not found', 404);
  const n = Number(c.req.param('version'));
  const versions = await descriptionVersions(issue);
  const v = Number.isInteger(n) ? versions.find((x) => x.version === n) : undefined;
  if (!v) return bad(c, 'Version not found', 404);
  const prev = versions.find((x) => x.version === n - 1);
  const current = versions[versions.length - 1];
  const users = await userNames([v.authorId]);
  return c.json({
    version: v.version, createdAt: v.createdAt?.toISOString() ?? null, current: v.current,
    author: v.authorId ? users.get(v.authorId) ?? null : null,
    text: v.text,
    // diff against the previous version (what this change did) and against the live description (what a restore would do)
    diffFromPrevious: prev ? diffLines(prev.text, v.text) : null,
    diffToCurrent: v.current ? null : diffLines(v.text, current.text),
  });
});

app.post('/rest/api/2/issue/:key/description-history/:version/restore', requireAuth, requireIssueAccess('EDIT_ISSUES'), async (c) => {
  const user = c.get('user')!;
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, c.req.param('key'))).limit(1);
  if (!issue) return bad(c, 'Issue not found', 404);
  const n = Number(c.req.param('version'));
  const versions = await descriptionVersions(issue);
  const v = Number.isInteger(n) ? versions.find((x) => x.version === n) : undefined;
  if (!v) return bad(c, 'Version not found', 404);
  if (v.current) return bad(c, 'This is already the current description', 409);
  // updateIssue records the change as a new history row, i.e. a new version.
  await updateIssue(issue.id, { description: v.text }, user.id);
  await invalidateIssueCache(issue.issueKey);
  const updated = await getIssue(issue.id);
  if (updated) publishIssue('issue.updated', updated, user.id);
  return c.json({ restoredVersion: v.version, newVersion: versions.length + 1 });
});

/* ------------------------------ type switch ------------------------------ */

const changeTypeSchema = z.object({
  issueTypeId: z.coerce.number().int().positive(),
  statusId: z.coerce.number().int().positive().optional(),
  parentKey: z.string().trim().min(1).max(100).optional(),
}).strict();

app.post('/rest/api/2/issue/:key/change-type', requireAuth, requireIssueAccess('EDIT_ISSUES'), async (c) => {
  const user = c.get('user')!;
  const raw = await c.req.json().catch(() => null);
  const parsed = changeTypeSchema.safeParse(raw);
  if (!parsed.success) return bad(c, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const key = c.req.param('key');
  try {
    if (c.req.query('preview') === 'true') {
      return c.json({ preview: true, ...(await planTypeChange(key, parsed.data)) });
    }
    const plan = await applyTypeChange(key, parsed.data, user.id);
    await invalidateIssueCache(key);
    const updated = await getIssue(plan.issueId);
    if (updated) publishIssue('issue.updated', updated, user.id);
    void recordAudit({
      actorId: user.id, actorName: user.username, action: 'ISSUE_TYPE_CHANGED', targetType: 'issue', target: key,
      method: 'POST', path: c.req.path, status: 200,
      details: { from: plan.from.name, to: plan.to.name, droppedFields: plan.droppedFields.map((d) => d.name), statusChanged: plan.status.target ? plan.status.target.id !== plan.status.current.id : false },
    });
    return c.json({ preview: false, ...plan, issue: updated });
  } catch (err) {
    if (err instanceof TypeChangeError) return bad(c, err.message, err.status);
    throw err;
  }
});

/* --------------------------- workflow governance -------------------------- */

async function isProjectAdmin(user: any, projectId: number) {
  return (await checkProjectPermission(user, projectId, 'PROJECT_ADMIN')) || (await checkProjectPermission(user, projectId, 'ADMINISTER_PROJECTS'));
}

async function canReassignScheme(user: any): Promise<boolean> {
  if ((await getWorkflowGovernance()) === 'any') return true;
  return (await isAdminUser(user)) || (await checkGlobalPermission(user, 'SYSTEM_ADMIN'));
}

app.get('/rest/api/2/project/:key/workflow-scheme', requireAuth, async (c) => {
  const user = c.get('user')!;
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, c.req.param('key').toUpperCase())).limit(1);
  if (!p || !(await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS'))) return bad(c, 'Project not found', 404);
  const [assoc] = await db.select().from(schema.workflowSchemeAssociations).where(eq(schema.workflowSchemeAssociations.projectId, p.id)).limit(1);
  const [scheme] = assoc ? await db.select().from(schema.workflowSchemes).where(eq(schema.workflowSchemes.id, assoc.schemeId)).limit(1) : [];
  const governance = await getWorkflowGovernance();
  return c.json({
    scheme: scheme ? { id: scheme.id, name: scheme.name } : null,
    governance,
    canChange: (await isProjectAdmin(user, p.id)) && (await canReassignScheme(user)),
  });
});

app.put('/rest/api/2/project/:key/workflow-scheme', requireAuth, async (c) => {
  const user = c.get('user')!;
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, c.req.param('key').toUpperCase())).limit(1);
  if (!p || !(await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS'))) return bad(c, 'Project not found', 404);
  if (!(await isProjectAdmin(user, p.id))) return bad(c, 'Forbidden', 403);
  if (!(await canReassignScheme(user))) {
    return bad(c, 'Workflow governance is "constrained": only system administrators can change the workflow scheme of a project', 403);
  }
  const body = z.object({ schemeId: z.number().int().positive() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, 'schemeId is required');
  const [scheme] = await db.select().from(schema.workflowSchemes).where(eq(schema.workflowSchemes.id, body.data.schemeId)).limit(1);
  if (!scheme) return bad(c, 'Workflow scheme not found', 404);
  await db.transaction(async (tx) => {
    await tx.delete(schema.workflowSchemeAssociations).where(eq(schema.workflowSchemeAssociations.projectId, p.id));
    await tx.insert(schema.workflowSchemeAssociations).values({ projectId: p.id, schemeId: scheme.id });
  });
  const items = await db.select({ w: schema.workflowSchemeItems.workflowId }).from(schema.workflowSchemeItems).where(eq(schema.workflowSchemeItems.schemeId, scheme.id));
  for (const w of new Set(items.map((i) => i.w))) {
    await logWorkflowChange(w, user.id, { targetType: 'scheme', action: 'assigned', summary: `Workflow scheme "${scheme.name}" assigned to project ${p.projectKey} by a project administrator` });
  }
  void recordAudit({ actorId: user.id, actorName: user.username, action: 'WORKFLOW_SCHEME_ASSIGNED', targetType: 'workflow_scheme', target: String(scheme.id), method: 'PUT', path: c.req.path, status: 200, details: { project: p.projectKey } });
  return c.json({ scheme: { id: scheme.id, name: scheme.name } });
});

export default app;
