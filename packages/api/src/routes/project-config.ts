import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, sessionMiddleware, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { requirePermission } from '../middleware/permissions';
import { invalidatePermissionCache } from '../rbac/service';
import { invalidateIssueCache, invalidateProjectCache } from '../middleware/cache';
import { ensureAuditTable } from '../audit/log';
import { PERMISSION_INFO } from '../rbac/permission-info';

/**
 * Project-level configuration screens: who may do what (edit), the audit trail of the project, a cache refresh
 * ("re-index") and the notification rules that apply to it.
 */
const app = new Hono<AppContext>();
app.use('/rest/api/2/project/*', sessionMiddleware);

async function projectByKey(key: string) {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
  return p ?? null;
}

/* ---------------- permissions: grant / revoke on the project's scheme ---------------- */

const holderSchema = z.object({
  permission: z.string(),
  type: z.enum(['role', 'group', 'user', 'projectLead', 'anyUser', 'anonymous']),
  id: z.number().int().positive().optional(),
  /** When the scheme is shared with other projects: edit a private copy for this project only. */
  copyScheme: z.boolean().optional(),
});

/** The scheme of the project to edit: its own, a private copy of a shared one on request, or a new one when it has none. */
async function editableScheme(project: { id: number; projectKey: string }, copyScheme: boolean): Promise<number> {
  const [assoc] = await db.select().from(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, project.id)).limit(1);
  const makeCopy = async (fromId: number | null, name: string) => {
    const [created] = await db.insert(schema.permissionSchemes).values({ name, description: `Permission scheme of ${project.projectKey}` }).returning();
    if (fromId) {
      const entries = await db.select().from(schema.permissionEntries).where(eq(schema.permissionEntries.schemeId, fromId));
      if (entries.length) {
        await db.insert(schema.permissionEntries).values(entries.map((e) => ({
          schemeId: created.id, permissionKey: e.permissionKey, userId: e.userId, groupId: e.groupId,
          projectRoleId: e.projectRoleId, anyUser: e.anyUser, projectLead: e.projectLead, anonymous: e.anonymous,
        })));
      }
    }
    await db.delete(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, project.id));
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: project.id, schemeId: created.id });
    return created.id;
  };
  if (!assoc) return makeCopy(null, `${project.projectKey} permission scheme`);
  if (!copyScheme) return assoc.schemeId;
  const [used] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.schemeId, assoc.schemeId));
  if ((used?.n ?? 0) <= 1) return assoc.schemeId;
  const [from] = await db.select().from(schema.permissionSchemes).where(eq(schema.permissionSchemes.id, assoc.schemeId)).limit(1);
  return makeCopy(assoc.schemeId, `${from?.name ?? 'Permission scheme'} (${project.projectKey})`);
}

const holderMatch = (schemeId: number, b: z.infer<typeof holderSchema>) => and(
  eq(schema.permissionEntries.schemeId, schemeId),
  eq(schema.permissionEntries.permissionKey, b.permission),
  b.type === 'role' ? eq(schema.permissionEntries.projectRoleId, b.id ?? -1)
    : b.type === 'group' ? eq(schema.permissionEntries.groupId, b.id ?? -1)
    : b.type === 'user' ? eq(schema.permissionEntries.userId, b.id ?? -1)
    : b.type === 'projectLead' ? eq(schema.permissionEntries.projectLead, true)
    : b.type === 'anyUser' ? eq(schema.permissionEntries.anyUser, true)
    : eq(schema.permissionEntries.anonymous, true),
);

function checkHolder(b: z.infer<typeof holderSchema>): string | null {
  if (!PERMISSION_INFO[b.permission]) return `Unknown permission ${b.permission}`;
  if (['role', 'group', 'user'].includes(b.type) && !b.id) return `${b.type} id is required`;
  return null;
}

app.post('/rest/api/2/project/:key/permissions/grant', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', holderSchema), async (c) => {
  const project = await projectByKey(c.req.param('key'));
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);
  const b = c.req.valid('json');
  const bad = checkHolder(b);
  if (bad) return c.json({ errorMessages: [bad] }, 400);
  const schemeId = await editableScheme(project, !!b.copyScheme);
  const [dup] = await db.select({ id: schema.permissionEntries.id }).from(schema.permissionEntries).where(holderMatch(schemeId, b)).limit(1);
  if (!dup) {
    await db.insert(schema.permissionEntries).values({
      schemeId, permissionKey: b.permission,
      projectRoleId: b.type === 'role' ? b.id : null, groupId: b.type === 'group' ? b.id : null, userId: b.type === 'user' ? b.id : null,
      projectLead: b.type === 'projectLead', anyUser: b.type === 'anyUser', anonymous: b.type === 'anonymous',
    });
  }
  await invalidatePermissionCache().catch(() => {});
  await invalidateProjectCache(project.projectKey);
  return c.json({ success: true, schemeId });
});

app.post('/rest/api/2/project/:key/permissions/revoke', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', holderSchema), async (c) => {
  const project = await projectByKey(c.req.param('key'));
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);
  const b = c.req.valid('json');
  const bad = checkHolder(b);
  if (bad) return c.json({ errorMessages: [bad] }, 400);
  const schemeId = await editableScheme(project, !!b.copyScheme);
  await db.delete(schema.permissionEntries).where(holderMatch(schemeId, b));
  await invalidatePermissionCache().catch(() => {});
  await invalidateProjectCache(project.projectKey);
  return c.json({ success: true, schemeId });
});

/* ---------------- audit trail of the project ---------------- */

const esc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

app.get('/rest/api/2/project/:key/audit', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const project = await projectByKey(c.req.param('key'));
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);
  await ensureAuditTable();
  const startAt = Math.max(0, Number(c.req.query('startAt')) || 0);
  const maxResults = Math.min(100, Math.max(1, Number(c.req.query('maxResults')) || 50));
  const key = project.projectKey;
  const q = (c.req.query('q') || '').trim().slice(0, 100);
  // rows about the project itself, its issues (target ABC-12) or anything under /project/ABC
  const scope = or(
    eq(schema.auditLog.target, key),
    ilike(schema.auditLog.target, `${esc(key)}-%`),
    ilike(schema.auditLog.path, `%/project/${esc(key)}%`),
    ilike(schema.auditLog.path, `%/issue/${esc(key)}-%`),
  )!;
  const text = q ? or(ilike(schema.auditLog.action, `%${esc(q)}%`), ilike(schema.auditLog.actorName, `%${esc(q)}%`), ilike(schema.auditLog.target, `%${esc(q)}%`))! : undefined;
  const where = text ? and(scope, text) : scope;
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.auditLog).where(where);
  const rows = await db.select().from(schema.auditLog).where(where).orderBy(desc(schema.auditLog.createdAt)).limit(maxResults).offset(startAt);
  return c.json({
    startAt, maxResults, total, isLast: startAt + rows.length >= total,
    values: rows.map((r) => ({ id: r.id, createdAt: r.createdAt, actor: r.actorName, action: r.action, targetType: r.targetType, target: r.target, method: r.method, path: r.path, status: r.status })),
  });
});

/* ---------------- "re-index": refresh the caches of the project ---------------- */

app.post('/rest/api/2/project/:key/reindex', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const project = await projectByKey(c.req.param('key'));
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);
  const started = Date.now();
  await invalidateProjectCache(project.projectKey);
  await invalidateIssueCache();
  await invalidatePermissionCache().catch(() => {});
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.issues).where(eq(schema.issues.projectId, project.id));
  return c.json({ success: true, issues: n, tookMs: Date.now() - started });
});

/* ---------------- notification rules that apply to the project ---------------- */

app.get('/rest/api/2/project/:key/notifications', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const project = await projectByKey(c.req.param('key'));
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);
  const schemes = await db.select().from(schema.notificationSchemes)
    .where(or(eq(schema.notificationSchemes.projectId, project.id), eq(schema.notificationSchemes.isDefault, true)));
  // a scheme made for this project wins over the default one (the same rule the notification code uses)
  const scheme = schemes.find((s) => s.projectId === project.id) ?? schemes.find((s) => s.isDefault) ?? null;
  const events = scheme ? await db.select().from(schema.notificationSchemeEvents).where(eq(schema.notificationSchemeEvents.schemeId, scheme.id)) : [];
  return c.json({
    scheme: scheme ? { id: scheme.id, name: scheme.name, description: scheme.description, forThisProject: scheme.projectId === project.id } : null,
    events: events.map((e) => ({
      event: e.eventType, assignee: !!e.notifyAssignee, reporter: !!e.notifyReporter, watchers: !!e.notifyWatchers,
      projectLead: !!e.notifyProjectLead, allAdmins: !!e.notifyAllAdmins, currentUser: !!e.notifyCurrentUser,
    })),
  });
});

export default app;
