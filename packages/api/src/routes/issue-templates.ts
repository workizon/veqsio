/**
 * Issue templates. Project templates belong to one project, global templates (no project) are available everywhere.
 * Use (list, prefill, create): CREATE_ISSUES in the project, for global templates CREATE_ISSUES anywhere.
 * Manage (create, change, delete): PROJECT_ADMIN for a project template, ADMINISTER for a global one.
 * Archived projects are read-only (answered 409 by the archive guard before these handlers run).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { asc, eq, isNull, or } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { checkGlobalPermission, checkProjectPermission } from '../middleware/permissions';
import { buildCreateRequest, checkTemplateRefs, serializeTemplate, templateNameTaken, type TemplateRow } from '../templates/service';
import { createIssue } from '../issues/service';
import { invalidateIssueCache } from '../middleware/cache';
import { publishIssue } from '../realtime/publish';
import { notifyIssueCreated } from '../services/notifications';

const app = new Hono<AppContext>();
app.use('/rest/api/2/issue-template*', sessionMiddleware);

const fields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  issueTypeId: z.number().int().positive(),
  summaryPattern: z.string().max(255).default(''),
  body: z.string().max(20000).default(''),
  priorityId: z.number().int().positive().nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(255).regex(/^[^,\s]+$/, 'labels cannot contain spaces or commas')).max(20).default([]),
  components: z.array(z.string().trim().min(1).max(255)).max(20).default([]),
  assigneeId: z.number().int().positive().nullable().optional(),
  customFields: z.array(z.object({ fieldId: z.number().int().positive(), value: z.unknown() }).strict()).max(50).default([]),
};
const createBody = z.object({ projectKey: z.string().trim().regex(/^[A-Z][A-Z0-9]{1,9}$/).nullable().optional(), ...fields }).strict();
const updateBody = z.object(fields).partial().strict();
const fromTemplateBody = z.object({ projectKey: z.string().trim().regex(/^[A-Z][A-Z0-9]{1,9}$/), summary: z.string().trim().min(1).max(255).optional(), description: z.string().max(100000).optional() }).strict();

const bad = (c: any, msgs: string[]) => c.json({ errorMessages: msgs }, 400);
const zerr = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);

async function projectByKey(key: string) {
  const [p] = await db.select({ id: schema.projects.id, projectKey: schema.projects.projectKey, archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
  return p;
}

async function canUse(user: any, projectId: number | null) {
  return projectId === null ? checkGlobalPermission(user, 'CREATE_ISSUES') : checkProjectPermission(user, projectId, 'CREATE_ISSUES');
}
async function canManage(user: any, projectId: number | null) {
  return projectId === null ? checkGlobalPermission(user, 'ADMINISTER') : checkProjectPermission(user, projectId, 'PROJECT_ADMIN');
}

async function loadTemplate(id: number): Promise<{ t: TemplateRow; key: string | null } | null> {
  const [t] = await db.select().from(schema.issueTemplates).where(eq(schema.issueTemplates.id, id)).limit(1);
  if (!t) return null;
  if (t.projectId === null) return { t, key: null };
  const [p] = await db.select({ key: schema.projects.projectKey }).from(schema.projects).where(eq(schema.projects.id, t.projectId)).limit(1);
  return { t, key: p?.key ?? null };
}

// List: the project's templates plus the global ones (or only the global ones without ?projectKey).
app.get('/rest/api/2/issue-template', requireAuth, async (c) => {
  const user = c.get('user')!;
  const key = c.req.query('projectKey');
  let projectId: number | null = null;
  if (key) {
    const p = await projectByKey(key.toUpperCase());
    if (!p || !(await canUse(user, p.id))) return c.json({ errorMessages: ['Project not found'] }, 404);
    projectId = p.id;
  } else if (!(await canUse(user, null))) return c.json({ errorMessages: ['Forbidden'] }, 403);
  const rows = await db.select().from(schema.issueTemplates)
    .where(projectId === null ? isNull(schema.issueTemplates.projectId) : or(isNull(schema.issueTemplates.projectId), eq(schema.issueTemplates.projectId, projectId)))
    .orderBy(asc(schema.issueTemplates.name));
  const [manageProject, manageGlobal] = await Promise.all([projectId === null ? false : canManage(user, projectId), canManage(user, null)]);
  return c.json({
    canManageProject: manageProject, canManageGlobal: manageGlobal,
    templates: rows.map((t) => serializeTemplate(t, t.projectId === null ? null : key!.toUpperCase())),
  });
});

app.get('/rest/api/2/issue-template/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const found = await loadTemplate(Number(c.req.param('id')));
  if (!found || !(await canUse(user, found.t.projectId))) return c.json({ errorMessages: ['Template not found'] }, 404);
  return c.json(serializeTemplate(found.t, found.key));
});

// What the create form should be prefilled with when this template is applied to a project.
app.get('/rest/api/2/issue-template/:id/prefill', requireAuth, async (c) => {
  const user = c.get('user')!;
  const found = await loadTemplate(Number(c.req.param('id')));
  const key = c.req.query('projectKey')?.toUpperCase();
  if (!found || !key) return c.json({ errorMessages: [found ? 'projectKey is required' : 'Template not found'] }, found ? 400 : 404);
  const project = await projectByKey(key);
  if (!project || !(await canUse(user, project.id)) || (found.t.projectId !== null && found.t.projectId !== project.id)) return c.json({ errorMessages: ['Template not found'] }, 404);
  const req = await buildCreateRequest(found.t, project, { at: new Date(), timezone: user.timezone || 'UTC' }).catch((e) => e as Error);
  if (req instanceof Error) return bad(c, [req.message]);
  return c.json(req);
});

app.post('/rest/api/2/issue-template', requireAuth, async (c) => {
  const user = c.get('user')!;
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, zerr(parsed.error));
  const b = parsed.data;
  let projectId: number | null = null;
  if (b.projectKey) {
    const p = await projectByKey(b.projectKey);
    if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
    projectId = p.id;
  }
  if (!(await canManage(user, projectId))) return c.json({ errorMessages: ['Forbidden'] }, 403);
  const refErr = await checkTemplateRefs(b);
  if (refErr) return bad(c, [refErr]);
  if (await templateNameTaken(projectId, b.name)) return c.json({ errorMessages: [`A template named "${b.name}" already exists here`] }, 409);
  const [row] = await db.insert(schema.issueTemplates).values({
    projectId, name: b.name, description: b.description ?? null, issueTypeId: b.issueTypeId, summaryPattern: b.summaryPattern, body: b.body,
    priorityId: b.priorityId ?? null, labels: b.labels, componentNames: b.components, assigneeId: b.assigneeId ?? null,
    customFields: b.customFields as any, createdBy: user.id,
  }).returning();
  return c.json(serializeTemplate(row, b.projectKey ?? null), 201);
});

app.put('/rest/api/2/issue-template/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const found = await loadTemplate(Number(c.req.param('id')));
  if (!found || !(await canUse(user, found.t.projectId))) return c.json({ errorMessages: ['Template not found'] }, 404);
  if (!(await canManage(user, found.t.projectId))) return c.json({ errorMessages: ['Forbidden'] }, 403);
  const parsed = updateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, zerr(parsed.error));
  const b = parsed.data;
  const refErr = await checkTemplateRefs(b);
  if (refErr) return bad(c, [refErr]);
  if (b.name && (await templateNameTaken(found.t.projectId, b.name, found.t.id))) return c.json({ errorMessages: [`A template named "${b.name}" already exists here`] }, 409);
  const set: Partial<typeof schema.issueTemplates.$inferInsert> = { updatedAt: new Date() };
  if (b.name !== undefined) set.name = b.name;
  if (b.description !== undefined) set.description = b.description;
  if (b.issueTypeId !== undefined) set.issueTypeId = b.issueTypeId;
  if (b.summaryPattern !== undefined) set.summaryPattern = b.summaryPattern;
  if (b.body !== undefined) set.body = b.body;
  if (b.priorityId !== undefined) set.priorityId = b.priorityId;
  if (b.labels !== undefined) set.labels = b.labels;
  if (b.components !== undefined) set.componentNames = b.components;
  if (b.assigneeId !== undefined) set.assigneeId = b.assigneeId;
  if (b.customFields !== undefined) set.customFields = b.customFields as any;
  const [row] = await db.update(schema.issueTemplates).set(set).where(eq(schema.issueTemplates.id, found.t.id)).returning();
  return c.json(serializeTemplate(row, found.key));
});

app.delete('/rest/api/2/issue-template/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const found = await loadTemplate(Number(c.req.param('id')));
  if (!found || !(await canUse(user, found.t.projectId))) return c.json({ errorMessages: ['Template not found'] }, 404);
  if (!(await canManage(user, found.t.projectId))) return c.json({ errorMessages: ['Forbidden'] }, 403);
  const [rule] = await db.select({ name: schema.recurringIssues.name }).from(schema.recurringIssues).where(eq(schema.recurringIssues.templateId, found.t.id)).limit(1);
  if (rule) return c.json({ errorMessages: [`The template is used by the recurring issue "${rule.name}". Delete or change that rule first.`] }, 409);
  await db.delete(schema.issueTemplates).where(eq(schema.issueTemplates.id, found.t.id));
  return c.json({});
});

// Create an issue straight from a template (API clients; the web form prefills instead and posts to /issue).
app.post('/rest/api/2/issue-template/:id/issue', requireAuth, async (c) => {
  const user = c.get('user')!;
  const found = await loadTemplate(Number(c.req.param('id')));
  const parsed = fromTemplateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, zerr(parsed.error));
  const project = await projectByKey(parsed.data.projectKey);
  if (!found || !project || (found.t.projectId !== null && found.t.projectId !== project.id) || !(await canUse(user, project.id))) return c.json({ errorMessages: ['Template not found'] }, 404);
  try {
    const req = await buildCreateRequest(found.t, project, { at: new Date(), timezone: user.timezone || 'UTC' });
    if (parsed.data.summary) req.summary = parsed.data.summary;
    if (parsed.data.description !== undefined) req.description = parsed.data.description;
    const issue = await createIssue(req, user.id);
    await invalidateIssueCache();
    publishIssue('issue.created', issue, user.id);
    try { await notifyIssueCreated(issue); } catch (e) { console.error('[notification] issue created from template:', e); }
    return c.json({ id: issue.id, key: issue.key, self: issue.self }, 201);
  } catch (err: any) {
    return bad(c, [err.message || 'Failed to create issue']);
  }
});

export default app;
