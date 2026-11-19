/**
 * Anonymous, read-only view of projects that an administrator made public.
 * An explicit allowlist of GET routes with their own queries (no reuse of the signed-in handlers), so nothing else
 * can leak: no emails or usernames, no internal comments, no attachments, no service desk projects, no custom fields.
 */
import { Hono } from 'hono';
import { and, count, desc, eq, ilike, inArray, notInArray, or, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { getInstanceSettings } from '../settings/instance';
import { issueVisibleSql } from '../security/issue-security';

/** Anonymous visitors never see an issue that has a security level. */
const ANON_VISIBLE = issueVisibleSql(null);

const app = new Hono();
const CACHE = 'public, max-age=60, s-maxage=60';

async function enabled(): Promise<boolean> {
  return !!(await getInstanceSettings()).publicProjectsEnabled;
}

/** Public projects, never service desk projects. */
async function publicProjectRows() {
  const desks = (await db.select({ id: schema.serviceDesks.projectId }).from(schema.serviceDesks)).map((d) => d.id);
  const where = desks.length ? and(eq(schema.projects.isPublic, true), notInArray(schema.projects.id, desks)) : eq(schema.projects.isPublic, true);
  return db.select().from(schema.projects).where(where).orderBy(schema.projects.projectKey);
}

async function publicProject(key: string) {
  return (await publicProjectRows()).find((p) => p.projectKey === key.toUpperCase());
}

/** Search engines may index a project unless the instance or the project says no. */
const indexable = async (p: { publicIndexing: string }) => (await getInstanceSettings()).publicIndexing !== 'none' && p.publicIndexing !== 'none';

const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404);
const clip = (v: string | undefined, n: number) => (v ?? '').slice(0, n);

app.use('/rest/public/*', async (c, next) => {
  await next();
  if (c.res.status === 200) c.res.headers.set('Cache-Control', CACHE);
});

app.get('/rest/public/config', async (c) => {
  const s = await getInstanceSettings();
  const rows = await db.select().from(schema.systemSettings).where(inArray(schema.systemSettings.key, ['site_name', 'base_url']));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return c.json({
    enabled: !!s.publicProjectsEnabled,
    indexing: s.publicIndexing,
    siteName: get('site_name') || process.env.SITE_NAME || 'Veqsio',
    baseUrl: (get('base_url') || process.env.PUBLIC_URL || process.env.BASE_URL || '').replace(/\/+$/, ''),
  });
});

app.get('/rest/public/projects', async (c) => {
  if (!(await enabled())) return notFound(c);
  const projects = await publicProjectRows();
  const counts = projects.length
    ? await db.select({ projectId: schema.issues.projectId, n: count() }).from(schema.issues).where(and(inArray(schema.issues.projectId, projects.map((p) => p.id)), ANON_VISIBLE)).groupBy(schema.issues.projectId)
    : [];
  return c.json({ projects: projects.map((p) => ({ key: p.projectKey, name: p.name, description: p.description, category: p.category, avatarUrl: p.avatarUrl, issueCount: Number(counts.find((x) => x.projectId === p.id)?.n ?? 0), updated: p.updatedAt })) });
});

app.get('/rest/public/projects/:key', async (c) => {
  if (!(await enabled())) return notFound(c);
  const p = await publicProject(c.req.param('key'));
  if (!p) return notFound(c);
  const [{ n }] = await db.select({ n: count() }).from(schema.issues).where(and(eq(schema.issues.projectId, p.id), ANON_VISIBLE));
  return c.json({ key: p.projectKey, name: p.name, description: p.description, category: p.category, avatarUrl: p.avatarUrl, issueCount: Number(n), updated: p.updatedAt, indexable: await indexable(p), board: p.publicBoard, roadmap: p.publicRoadmap });
});

app.get('/rest/public/projects/:key/issues', async (c) => {
  if (!(await enabled())) return notFound(c);
  const p = await publicProject(c.req.param('key'));
  if (!p) return notFound(c);
  const startAt = Math.max(Number(c.req.query('startAt')) || 0, 0);
  const maxResults = Math.min(Math.max(Number(c.req.query('maxResults')) || 25, 1), 50);
  const q = clip(c.req.query('q')?.trim(), 200);
  const type = clip(c.req.query('type')?.trim(), 100);
  const status = clip(c.req.query('status')?.trim(), 100);
  const conds = [eq(schema.issues.projectId, p.id), ANON_VISIBLE];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(or(ilike(schema.issues.summary, like), ilike(schema.issues.issueKey, like))!);
  }
  if (type) conds.push(eq(schema.issueTypes.name, type));
  if (status) conds.push(eq(schema.statuses.name, status));
  const where = and(...conds);
  const base = () => db.select().from(schema.issues)
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .leftJoin(schema.priorities, eq(schema.priorities.id, schema.issues.priorityId));
  const rows = await base().where(where).orderBy(desc(schema.issues.updatedAt), desc(schema.issues.id)).limit(maxResults).offset(startAt);
  const [{ n }] = await db.select({ n: count() }).from(schema.issues)
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId)).where(where);
  return c.json({
    startAt, maxResults, total: Number(n),
    issues: rows.map((r) => ({ key: r.issues.issueKey, summary: r.issues.summary, type: r.issue_types.name, status: r.statuses.name, statusCategory: r.statuses.category, priority: r.priorities?.name ?? null, created: r.issues.createdAt, updated: r.issues.updatedAt })),
  });
});

app.get('/rest/public/issues/:issueKey', async (c) => {
  if (!(await enabled())) return notFound(c);
  const [row] = await db.select().from(schema.issues)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.issues.projectId))
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .leftJoin(schema.priorities, eq(schema.priorities.id, schema.issues.priorityId))
    .where(and(eq(schema.issues.issueKey, c.req.param('issueKey').toUpperCase()), ANON_VISIBLE)).limit(1);
  const pub = row ? await publicProject(row.projects.projectKey) : undefined;
  if (!row || !pub) return notFound(c);
  const issue = row.issues;
  const names = async (ids: Array<number | null>) => {
    const list = ids.filter((x): x is number => x !== null);
    if (!list.length) return new Map<number, string>();
    return new Map((await db.select({ id: schema.users.id, name: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, list))).map((u) => [u.id, u.name]));
  };
  const comments = await db.select().from(schema.comments).where(and(eq(schema.comments.issueId, issue.id), eq(schema.comments.isInternal, false))).orderBy(schema.comments.createdAt).limit(200);
  const users = await names([issue.assigneeId, issue.reporterId, ...comments.map((x) => x.authorId)]);
  const labels = await db.select({ name: schema.labels.name }).from(schema.issueLabels).innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId)).where(eq(schema.issueLabels.issueId, issue.id));
  const fixVersions = await db.select({ name: schema.versions.name }).from(schema.issueFixVersions).innerJoin(schema.versions, eq(schema.versions.id, schema.issueFixVersions.versionId)).where(eq(schema.issueFixVersions.issueId, issue.id));
  return c.json({
    key: issue.issueKey, summary: issue.summary, description: issue.description,
    project: { key: row.projects.projectKey, name: row.projects.name },
    indexable: await indexable(pub),
    type: row.issue_types.name, status: row.statuses.name, statusCategory: row.statuses.category, priority: row.priorities?.name ?? null,
    assignee: issue.assigneeId ? users.get(issue.assigneeId) ?? null : null,
    reporter: users.get(issue.reporterId) ?? null,
    labels: labels.map((l) => l.name), fixVersions: fixVersions.map((v) => v.name),
    created: issue.createdAt, updated: issue.updatedAt, resolved: issue.resolvedAt,
    comments: comments.map((x) => ({ id: x.id, author: x.authorId ? users.get(x.authorId) ?? null : null, body: x.body, created: x.createdAt })),
  });
});

/** The project's first board as a read-only column view (only when the project turned the public board on). */
app.get('/rest/public/projects/:key/board', async (c) => {
  if (!(await enabled())) return notFound(c);
  const p = await publicProject(c.req.param('key'));
  if (!p || !p.publicBoard) return notFound(c);
  const [board] = await db.select().from(schema.boards).where(eq(schema.boards.projectId, p.id)).orderBy(schema.boards.id).limit(1);
  if (!board) return notFound(c);
  const cols = await db.select().from(schema.boardColumns).where(eq(schema.boardColumns.boardId, board.id)).orderBy(schema.boardColumns.sortOrder, schema.boardColumns.id);
  const out = [];
  for (const col of cols.slice(0, 12)) {
    if (col.statusId === null) { out.push({ name: col.name, total: 0, issues: [] }); continue; }
    const where = and(eq(schema.issues.projectId, p.id), eq(schema.issues.statusId, col.statusId), ANON_VISIBLE);
    const [{ n }] = await db.select({ n: count() }).from(schema.issues).where(where);
    const rows = await db.select().from(schema.issues)
      .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
      .leftJoin(schema.priorities, eq(schema.priorities.id, schema.issues.priorityId))
      .where(where).orderBy(desc(schema.issues.updatedAt), desc(schema.issues.id)).limit(25);
    out.push({ name: col.name, total: Number(n), issues: rows.map((r) => ({ key: r.issues.issueKey, summary: r.issues.summary, type: r.issue_types.name, priority: r.priorities?.name ?? null })) });
  }
  return c.json({ board: { name: board.name }, columns: out });
});

/** Versions with their progress (only when the project turned the public roadmap on). Archived versions stay out. */
app.get('/rest/public/projects/:key/roadmap', async (c) => {
  if (!(await enabled())) return notFound(c);
  const p = await publicProject(c.req.param('key'));
  if (!p || !p.publicRoadmap) return notFound(c);
  const versions = await db.select().from(schema.versions).where(and(eq(schema.versions.projectId, p.id), eq(schema.versions.archived, false))).orderBy(schema.versions.releaseDate, schema.versions.id).limit(100);
  const progress = versions.length
    ? await db.select({ versionId: schema.issueFixVersions.versionId, category: schema.statuses.category, n: count() }).from(schema.issueFixVersions)
        .innerJoin(schema.issues, eq(schema.issues.id, schema.issueFixVersions.issueId))
        .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
        .where(and(inArray(schema.issueFixVersions.versionId, versions.map((v) => v.id)), ANON_VISIBLE))
        .groupBy(schema.issueFixVersions.versionId, schema.statuses.category)
    : [];
  return c.json({
    versions: versions.map((v) => {
      const mine = progress.filter((x) => x.versionId === v.id);
      const total = mine.reduce((a, x) => a + Number(x.n), 0);
      const done = mine.filter((x) => x.category === 'done').reduce((a, x) => a + Number(x.n), 0);
      return { name: v.name, description: v.description ? clip(v.description, 500) : null, startDate: v.startDate, releaseDate: v.releaseDate, released: !!v.released, issues: { total, done } };
    }),
  });
});

const SITEMAP_PAGE = 5000;
app.get('/rest/public/sitemap', async (c) => {
  if (!(await enabled())) return notFound(c);
  const page = Math.max(Number(c.req.query('page')) || 0, 0);
  // projects that opted out of indexing do not appear in the sitemap at all
  const projects = (await publicProjectRows()).filter((p) => p.publicIndexing !== 'none');
  if (!projects.length) return c.json({ projects: [], issues: [], page, pages: 0 });
  const ids = projects.map((p) => p.id);
  const [{ n }] = await db.select({ n: count() }).from(schema.issues).where(and(inArray(schema.issues.projectId, ids), ANON_VISIBLE));
  const issues = await db.select({ key: schema.issues.issueKey, projectId: schema.issues.projectId, updated: schema.issues.updatedAt }).from(schema.issues)
    .where(and(inArray(schema.issues.projectId, ids), ANON_VISIBLE)).orderBy(desc(schema.issues.updatedAt), desc(schema.issues.id)).limit(SITEMAP_PAGE).offset(page * SITEMAP_PAGE);
  return c.json({
    page, pages: Math.max(Math.ceil(Number(n) / SITEMAP_PAGE), 1),
    projects: page === 0 ? projects.map((p) => ({ key: p.projectKey, updated: p.updatedAt })) : [],
    issues: issues.map((i) => ({ key: i.key, project: projects.find((p) => p.id === i.projectId)!.projectKey, updated: i.updated })),
  });
});

export default app;
