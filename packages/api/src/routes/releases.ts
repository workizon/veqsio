import { Hono } from 'hono';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { checkProjectPermission } from '../middleware/permissions';
import { milestoneProgress } from '../milestones/rules';
import { baseCategory } from '../workflow/status-groups';

/**
 * Releases view of a project.
 *
 *   GET /rest/api/2/project/:key/releases[?archived=true]
 *
 * Versions (newest first) with their fix-version issues, progress (cancelled excluded) and the number of issues that
 * are still open. Needs BROWSE_PROJECTS (404 otherwise). `canRelease` tells the UI whether the caller may mark a
 * version released, which uses the existing version endpoint (`PUT /rest/api/2/project/:key/versions/:id`
 * `{released: true}`, PROJECT_ADMIN). Release notes: `GET /rest/api/2/project/:key/versions/:id/release-notes`.
 */
const app = new Hono<AppContext>();

app.get('/rest/api/2/project/:key/releases', requireAuth, async (c) => {
  const user = c.get('user')!;
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, c.req.param('key').toUpperCase())).limit(1);
  if (!project || !(await checkProjectPermission(user, project.id, 'BROWSE_PROJECTS'))) return c.json({ errorMessages: ['Not found'] }, 404);
  const includeArchived = c.req.query('archived') === 'true';
  const versions = await db.select().from(schema.versions)
    .where(includeArchived ? eq(schema.versions.projectId, project.id) : and(eq(schema.versions.projectId, project.id), eq(schema.versions.archived, false)))
    .orderBy(desc(schema.versions.id));
  const rows = versions.length
    ? await db.select({
      versionId: schema.issueFixVersions.versionId, key: schema.issues.issueKey, summary: schema.issues.summary, type: schema.issueTypes.name,
      status: schema.statuses.name, category: schema.statuses.category,
    })
      .from(schema.issueFixVersions)
      .innerJoin(schema.issues, eq(schema.issues.id, schema.issueFixVersions.issueId))
      .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
      .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
      .where(and(inArray(schema.issueFixVersions.versionId, versions.map((v) => v.id)), eq(schema.issues.projectId, project.id)))
      .orderBy(asc(schema.issues.id))
    : [];
  const today = new Date().toISOString().slice(0, 10);
  return c.json({
    project: { key: project.projectKey, name: project.name },
    canRelease: await checkProjectPermission(user, project.id, 'PROJECT_ADMIN'),
    versions: versions.map((v) => {
      const issues = rows.filter((r) => r.versionId === v.id);
      return {
        id: v.id, name: v.name, description: v.description, startDate: v.startDate, releaseDate: v.releaseDate,
        released: !!v.released, archived: !!v.archived,
        overdue: !v.released && !!v.releaseDate && v.releaseDate < today,
        progress: milestoneProgress(issues),
        openIssueCount: issues.filter((i) => baseCategory(i.category) !== 'done').length,
        issues: issues.map((i) => ({ key: i.key, summary: i.summary, type: i.type, status: i.status, statusCategory: i.category })),
      };
    }),
  });
});

export default app;
