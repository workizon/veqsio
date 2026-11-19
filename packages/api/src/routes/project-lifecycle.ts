/**
 * Project lifecycle: the template catalogue, the preview of "copy settings from a project", archive and restore.
 * (Creating a project with a template / copy lives in routes/projects.ts; deleting, which requires an archived
 * project and a typed confirmation, too.)
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requirePermission } from '../middleware/permissions';
import { invalidateCache, invalidateIssueCache, invalidateProjectCache } from '../middleware/cache';
import { recordAudit } from '../audit/log';
import { PROJECT_TEMPLATES, previewCopy } from '../projects/templates';

const app = new Hono<AppContext>();
app.use('/rest/api/2/project-template*', sessionMiddleware);
app.use('/rest/api/2/project/*/archive', sessionMiddleware);
app.use('/rest/api/2/project/*/restore', sessionMiddleware);
app.use('/rest/api/2/project/*/copy-preview', sessionMiddleware);

app.get('/rest/api/2/project-template', requireAuth, (c) => c.json({
  templates: PROJECT_TEMPLATES.map((t) => ({
    id: t.id, name: t.name, description: t.description, board: t.board, components: t.components, versions: t.versions,
    issueTemplates: t.issueTemplates.map((i) => ({ name: i.name, issueType: i.issueType })),
  })),
}));

async function projectByKey(key: string) {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
  return p;
}

// Reading the source's configuration for a copy needs PROJECT_ADMIN on the source (role actors are part of the preview).
app.get('/rest/api/2/project/:key/copy-preview', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  return c.json({ key: p.projectKey, name: p.name, ...(await previewCopy(p.id, db)) });
});

async function setArchived(c: any, archive: boolean) {
  const user = c.get('user')!;
  const p = await projectByKey(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  if (archive && p.archivedAt) return c.json({ errorMessages: ['The project is already archived'] }, 409);
  if (!archive && !p.archivedAt) return c.json({ errorMessages: ['The project is not archived'] }, 409);
  await db.update(schema.projects).set({ archivedAt: archive ? new Date() : null, archivedBy: archive ? user.id : null, updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
  await invalidateProjectCache(p.projectKey);
  await invalidateIssueCache().catch(() => {});
  await invalidateCache(`veqsio:cache:*:/rest/api/2/board*`).catch(() => {});
  await invalidateCache(`veqsio:cache:*:/rest/agile/1.0/board*`).catch(() => {});
  void recordAudit({
    actorId: user.id, actorName: user.username, action: archive ? 'PROJECT_ARCHIVED' : 'PROJECT_RESTORED', targetType: 'project', target: p.projectKey,
    method: c.req.method, path: c.req.path, status: 200, details: { name: p.name },
  });
  return c.json({ key: p.projectKey, archived: archive });
}

app.post('/rest/api/2/project/:key/archive', requireAuth, requirePermission('PROJECT_ADMIN'), (c) => setArchived(c, true));
app.post('/rest/api/2/project/:key/restore', requireAuth, requirePermission('PROJECT_ADMIN'), (c) => setArchived(c, false));

export default app;
