/**
 * Wiki / Pages (feature switch `pages`). See docs/pages.md.
 *
 * Visibility: a workspace page (no project) is visible to every signed-in member of the organisation (not to portal-only
 * customers); a project page needs BROWSE_PROJECTS on its project. Anything the caller may not see answers 404, never 403.
 * Editing rules live in pages/rules.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { checkProjectPermission, requireInternalUser } from '../middleware/permissions';
import { getBrowsableProjectIds, isAdminUser } from '../services/browse';
import { issueVisibleSql } from '../security/issue-security';
import { createIssue } from '../issues/service';
import { invalidateIssueCache } from '../middleware/cache';
import { publishIssue } from '../realtime/publish';
import { notifyIssueCreated } from '../services/notifications';
import { collapseDiff, diffLines, diffSummary, summarizeDiff } from '../pages/diff';
import { canEditPage, canLockPage, canModeratePage, type PageFacts } from '../pages/rules';
import { descendantIds, nextPosition, reorderSiblings, wouldCreateCycle } from '../pages/tree';

type User = typeof schema.users.$inferSelect;
type PageRow = typeof schema.pages.$inferSelect;

const app = new Hono<AppContext>();
app.use('/rest/api/2/pages', sessionMiddleware);
app.use('/rest/api/2/pages/*', sessionMiddleware);
// The wiki is internal: portal-only customers get 404 for every page route.
app.use('/rest/api/2/pages', requireInternalUser);
app.use('/rest/api/2/pages/*', requireInternalUser);

const MAX_BODY = 200_000;
const notFound = (what = 'Page') => ({ errorMessages: [`${what} not found`] });
const badRequest = (e: z.ZodError) => ({ errorMessages: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });

/* ------------------------------ access ------------------------------ */

interface Loaded {
  row: PageRow;
  projectKey: string | null;
  projectName: string | null;
  authorName: string | null;
  facts: PageFacts;
  canEdit: boolean;
  canLock: boolean;
  canModerate: boolean;
  /** may add comments */
  canComment: boolean;
}

async function projectOf(key: string) {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
  return p;
}

/** Loads a page and the caller's rights on it; null when it does not exist or the caller may not see it. */
async function loadPage(user: User, id: number): Promise<Loaded | null> {
  const [r] = await db
    .select({ row: schema.pages, projectKey: schema.projects.projectKey, projectName: schema.projects.name, authorName: schema.users.displayName })
    .from(schema.pages)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.pages.projectId))
    .leftJoin(schema.users, eq(schema.users.id, schema.pages.authorId))
    .where(eq(schema.pages.id, id))
    .limit(1);
  if (!r) return null;
  const inProject = r.row.projectId !== null;
  const isAdmin = await isAdminUser(user);
  let canEditInProject = false;
  let isProjectAdmin = false;
  let canComment = true;
  if (inProject) {
    const pid = r.row.projectId!;
    if (!isAdmin && !(await checkProjectPermission(user, pid, 'BROWSE_PROJECTS'))) return null;
    canEditInProject = isAdmin || (await checkProjectPermission(user, pid, 'EDIT_ISSUES'));
    isProjectAdmin = isAdmin || (await checkProjectPermission(user, pid, 'PROJECT_ADMIN'));
    canComment = isAdmin || (await checkProjectPermission(user, pid, 'ADD_COMMENTS'));
  }
  const facts: PageFacts = { inProject, isAuthor: r.row.authorId === user.id, isAdmin, isProjectAdmin, canEditInProject, locked: r.row.locked };
  return {
    row: r.row, projectKey: r.projectKey, projectName: r.projectName, authorName: r.authorName, facts,
    canEdit: canEditPage(facts), canLock: canLockPage(facts), canModerate: canModeratePage(facts), canComment,
  };
}

const idOf = (v: string) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 2147483647 ? n : null; };

const scopeWhere = (projectId: number | null) => (projectId === null ? isNull(schema.pages.projectId) : eq(schema.pages.projectId, projectId));

/* ------------------------------ presentation ------------------------------ */

const summary = (r: { row: PageRow; projectKey: string | null; authorName: string | null }) => ({
  id: r.row.id,
  title: r.row.title,
  parentId: r.row.parentId,
  position: r.row.position,
  projectKey: r.projectKey,
  locked: r.row.locked,
  archived: r.row.archivedAt !== null,
  version: r.row.version,
  author: r.row.authorId ? { id: r.row.authorId, displayName: r.authorName } : null,
  createdAt: r.row.createdAt,
  updatedAt: r.row.updatedAt,
});

async function ancestors(row: PageRow): Promise<Array<{ id: number; title: string }>> {
  const all = await db.select({ id: schema.pages.id, parentId: schema.pages.parentId, title: schema.pages.title })
    .from(schema.pages).where(scopeWhere(row.projectId));
  const byId = new Map(all.map((p) => [p.id, p]));
  const out: Array<{ id: number; title: string }> = [];
  const seen = new Set<number>([row.id]);
  let cur = row.parentId;
  while (cur !== null && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const p = byId.get(cur)!;
    out.unshift({ id: p.id, title: p.title });
    cur = p.parentId;
  }
  return out;
}

async function linkedIssues(user: User, pageId: number) {
  const rows = await db
    .select({ link: schema.pageIssueLinks, key: schema.issues.issueKey, summary: schema.issues.summary, projectId: schema.issues.projectId, statusName: schema.statuses.name })
    .from(schema.pageIssueLinks)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.pageIssueLinks.issueId))
    .leftJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .where(and(eq(schema.pageIssueLinks.pageId, pageId), issueVisibleSql(user.id)))
    .orderBy(desc(schema.pageIssueLinks.id));
  if (!rows.length) return [];
  // The page may be readable by people who cannot browse the issue's project: those links are left out.
  const browsable = new Set(await getBrowsableProjectIds(user));
  return rows.filter((r) => browsable.has(r.projectId)).map((r) => ({
    id: r.link.id, issueKey: r.key, summary: r.summary, status: r.statusName, quote: r.link.quote, createdAt: r.link.createdAt,
  }));
}

/* ------------------------------ list and search ------------------------------ */

app.get('/rest/api/2/pages', requireAuth, async (c) => {
  const user = c.get('user')!;
  const projectKey = c.req.query('project');
  const onlyArchived = c.req.query('archived') === 'true';
  let where;
  if (projectKey) {
    const p = await projectOf(projectKey);
    if (!p || !(await isAdminUser(user) || (await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS')))) return c.json(notFound('Project'), 404);
    where = eq(schema.pages.projectId, p.id);
  } else if (c.req.query('workspace') === 'true') {
    where = isNull(schema.pages.projectId);
  } else {
    const ids = await getBrowsableProjectIds(user);
    where = ids.length ? sql`(${schema.pages.projectId} IS NULL OR ${inArray(schema.pages.projectId, ids)})` : isNull(schema.pages.projectId);
  }
  const rows = await db
    .select({ row: schema.pages, projectKey: schema.projects.projectKey, authorName: schema.users.displayName })
    .from(schema.pages)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.pages.projectId))
    .leftJoin(schema.users, eq(schema.users.id, schema.pages.authorId))
    .where(and(where, onlyArchived ? isNotNull(schema.pages.archivedAt) : isNull(schema.pages.archivedAt)))
    .orderBy(asc(schema.pages.position), asc(schema.pages.title), asc(schema.pages.id))
    .limit(2000);
  return c.json({ pages: rows.map(summary) });
});

app.get('/rest/api/2/pages/search', requireAuth, async (c) => {
  const user = c.get('user')!;
  const q = (c.req.query('q') ?? '').trim().slice(0, 200);
  if (q.length < 2) return c.json({ errorMessages: ['q must have at least 2 characters'] }, 400);
  const tokens = (q.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 8);
  if (!tokens.length) return c.json({ results: [] });
  const tsq = tokens.map((t) => `${t}:*`).join(' & ');
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;

  const projectKey = c.req.query('project');
  let scope;
  if (projectKey) {
    const p = await projectOf(projectKey);
    if (!p || !(await isAdminUser(user) || (await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS')))) return c.json(notFound('Project'), 404);
    scope = sql`p.project_id = ${p.id}`;
  } else {
    const ids = await getBrowsableProjectIds(user);
    scope = ids.length ? sql`(p.project_id IS NULL OR p.project_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}))` : sql`p.project_id IS NULL`;
  }
  const rows = (await db.execute(sql`
    WITH hits AS (
      SELECT p.id, p.title, p.body, p.project_id, p.updated_at,
             (p.title ILIKE ${like}) AS title_hit,
             ts_rank(to_tsvector('simple', p.title || ' ' || p.body), to_tsquery('simple', ${tsq})) AS rank
      FROM pages p
      WHERE p.archived_at IS NULL AND ${scope}
        AND (to_tsvector('simple', p.title || ' ' || p.body) @@ to_tsquery('simple', ${tsq}) OR p.title ILIKE ${like})
      ORDER BY title_hit DESC, rank DESC, p.updated_at DESC
      LIMIT 30
    )
    SELECT h.id, h.title, h.updated_at, pr.project_key,
           ts_headline('simple', h.body, to_tsquery('simple', ${tsq}), 'StartSel=[[, StopSel=]], MaxFragments=1, MaxWords=24, MinWords=8') AS snippet
    FROM hits h LEFT JOIN projects pr ON pr.id = h.project_id
    ORDER BY h.title_hit DESC, h.rank DESC, h.updated_at DESC
  `)) as unknown as Array<{ id: number; title: string; updated_at: string; project_key: string | null; snippet: string }>;
  return c.json({
    results: rows.map((r) => ({ id: r.id, title: r.title, projectKey: r.project_key, updatedAt: r.updated_at, snippet: String(r.snippet ?? '').replace(/\s+/g, ' ').trim() })),
  });
});

/* ------------------------------ create / read / update ------------------------------ */

const createBody = z.object({
  title: z.string().trim().min(1).max(255),
  body: z.string().max(MAX_BODY).optional(),
  parentId: z.number().int().positive().nullable().optional(),
  projectKey: z.string().trim().min(1).max(50).nullable().optional(),
}).strict();

app.post('/rest/api/2/pages', requireAuth, async (c) => {
  const user = c.get('user')!;
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(badRequest(parsed.error), 400);
  const b = parsed.data;
  let projectId: number | null = null;
  if (b.projectKey) {
    const p = await projectOf(b.projectKey);
    if (!p) return c.json(notFound('Project'), 404);
    const admin = await isAdminUser(user);
    if (!admin && !(await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS'))) return c.json(notFound('Project'), 404);
    if (!admin && !(await checkProjectPermission(user, p.id, 'EDIT_ISSUES'))) return c.json({ errorMessages: ['Forbidden'] }, 403);
    projectId = p.id;
  }
  if (b.parentId) {
    const parent = await loadPage(user, b.parentId);
    if (!parent) return c.json({ errorMessages: ['Parent page not found'] }, 400);
    if (parent.row.projectId !== projectId) return c.json({ errorMessages: ['The parent must be in the same project (or the workspace)'] }, 400);
    if (parent.row.archivedAt) return c.json({ errorMessages: ['The parent page is archived'] }, 400);
  }
  const body = b.body ?? '';
  const created = await db.transaction(async (tx) => {
    const siblings = await tx.select({ position: schema.pages.position }).from(schema.pages)
      .where(and(scopeWhere(projectId), b.parentId ? eq(schema.pages.parentId, b.parentId) : isNull(schema.pages.parentId)));
    const [row] = await tx.insert(schema.pages).values({
      projectId, parentId: b.parentId ?? null, title: b.title, body, authorId: user.id, updatedBy: user.id, position: nextPosition(siblings),
    }).returning();
    await tx.insert(schema.pageVersions).values({ pageId: row.id, version: 1, title: row.title, body, authorId: user.id, addedLines: diffSummary('', body).added, removedLines: 0 });
    return row;
  });
  return c.json({ id: created.id, version: created.version }, 201);
});

app.get('/rest/api/2/pages/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const page = id ? await loadPage(user, id) : null;
  if (!page) return c.json(notFound(), 404);
  const [crumbs, issues] = await Promise.all([ancestors(page.row), linkedIssues(user, page.row.id)]);
  return c.json({
    ...summary(page),
    body: page.row.body,
    projectName: page.projectName,
    ancestors: crumbs,
    linkedIssues: issues,
    permissions: { canEdit: page.canEdit && !page.row.archivedAt, canLock: page.canLock, canComment: page.canComment, canModerate: page.canModerate },
  });
});

const updateBody = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  body: z.string().max(MAX_BODY).optional(),
  locked: z.boolean().optional(),
  /** version the client edited; a different current version answers 409 instead of overwriting */
  expectedVersion: z.number().int().positive().optional(),
}).strict();

/** Writes a new version (page row plus history row) atomically; returns null when the page changed in the meantime. */
async function writeVersion(page: PageRow, user: User, next: { title: string; body: string }, restoredFrom?: number) {
  return db.transaction(async (tx) => {
    const version = page.version + 1;
    const [row] = await tx.update(schema.pages)
      .set({ title: next.title, body: next.body, version, updatedBy: user.id, updatedAt: new Date() })
      .where(and(eq(schema.pages.id, page.id), eq(schema.pages.version, page.version)))
      .returning();
    if (!row) return null;
    const d = diffSummary(page.body, next.body);
    await tx.insert(schema.pageVersions).values({
      pageId: page.id, version, title: next.title, body: next.body, authorId: user.id, addedLines: d.added, removedLines: d.removed, restoredFrom: restoredFrom ?? null,
    });
    return row;
  });
}

const conflict = (current: number) => ({ errorMessages: ['The page was changed by someone else. Reload it before saving.'], currentVersion: current });

app.put('/rest/api/2/pages/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const page = id ? await loadPage(user, id) : null;
  if (!page) return c.json(notFound(), 404);
  const parsed = updateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(badRequest(parsed.error), 400);
  const b = parsed.data;
  if (b.locked !== undefined && b.locked !== page.row.locked && !page.canLock) return c.json({ errorMessages: ['Only the author or an administrator can lock or unlock a page'] }, 403);
  const contentChange = (b.title !== undefined && b.title !== page.row.title) || (b.body !== undefined && b.body !== page.row.body);
  // Unlocking is allowed for whoever may lock, even though the page cannot be edited while locked.
  const onlyLockToggle = b.locked !== undefined && !contentChange;
  if (!(onlyLockToggle ? page.canLock : page.canEdit)) return c.json({ errorMessages: ['Forbidden'] }, 403);
  if (page.row.archivedAt) return c.json({ errorMessages: ['The page is archived; restore it first'] }, 409);
  if (b.expectedVersion !== undefined && b.expectedVersion !== page.row.version) return c.json(conflict(page.row.version), 409);

  let current = page.row;
  if (b.locked !== undefined && b.locked !== current.locked) {
    const [r] = await db.update(schema.pages).set({ locked: b.locked, updatedAt: new Date() }).where(eq(schema.pages.id, current.id)).returning();
    current = r;
  }
  if (contentChange) {
    const row = await writeVersion(current, user, { title: b.title ?? current.title, body: b.body ?? current.body });
    if (!row) return c.json(conflict((await loadPage(user, current.id))?.row.version ?? current.version), 409);
    current = row;
  }
  return c.json({ id: current.id, version: current.version, locked: current.locked, changed: contentChange });
});

/* ------------------------------ move / archive ------------------------------ */

const moveBody = z.object({
  parentId: z.number().int().positive().nullable(),
  index: z.number().int().min(0).max(100000).optional(),
}).strict();

app.post('/rest/api/2/pages/:id/move', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const page = id ? await loadPage(user, id) : null;
  if (!page) return c.json(notFound(), 404);
  if (!page.canEdit) return c.json({ errorMessages: ['Forbidden'] }, 403);
  if (page.row.archivedAt) return c.json({ errorMessages: ['The page is archived; restore it first'] }, 409);
  const parsed = moveBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(badRequest(parsed.error), 400);
  const { parentId, index } = parsed.data;

  const scope = await db.select({ id: schema.pages.id, parentId: schema.pages.parentId, position: schema.pages.position, title: schema.pages.title, archivedAt: schema.pages.archivedAt })
    .from(schema.pages).where(scopeWhere(page.row.projectId));
  const live = scope.filter((p) => !p.archivedAt);
  if (parentId !== null) {
    const parent = scope.find((p) => p.id === parentId);
    if (!parent) return c.json({ errorMessages: ['The parent must be a page in the same project (or the workspace)'] }, 400);
    if (parent.archivedAt) return c.json({ errorMessages: ['The parent page is archived'] }, 400);
  }
  if (wouldCreateCycle(live, page.row.id, parentId)) return c.json({ errorMessages: ['A page cannot be moved below itself'] }, 400);

  const siblings = live.filter((p) => p.parentId === parentId);
  const order = reorderSiblings(siblings, page.row.id, index ?? siblings.length);
  await db.transaction(async (tx) => {
    for (let i = 0; i < order.length; i++) {
      const pid = order[i];
      const patch = pid === page.row.id ? { parentId, position: i } : { position: i };
      const existing = pid === page.row.id ? null : siblings.find((s) => s.id === pid);
      if (existing && existing.position === i) continue;
      await tx.update(schema.pages).set(patch).where(eq(schema.pages.id, pid));
    }
  });
  return c.json({ id: page.row.id, parentId, position: order.indexOf(page.row.id) });
});

app.post('/rest/api/2/pages/:id/archive', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const page = id ? await loadPage(user, id) : null;
  if (!page) return c.json(notFound(), 404);
  if (!page.canEdit) return c.json({ errorMessages: ['Forbidden'] }, 403);
  if (page.row.archivedAt) return c.json({ id: page.row.id, archived: true, count: 0 });
  const scope = await db.select({ id: schema.pages.id, parentId: schema.pages.parentId, position: schema.pages.position, title: schema.pages.title, archivedAt: schema.pages.archivedAt })
    .from(schema.pages).where(scopeWhere(page.row.projectId));
  const ids = [page.row.id, ...descendantIds(scope, page.row.id).filter((d) => !scope.find((s) => s.id === d)?.archivedAt)];
  const at = new Date();
  await db.update(schema.pages).set({ archivedAt: at }).where(inArray(schema.pages.id, ids));
  return c.json({ id: page.row.id, archived: true, count: ids.length });
});

app.post('/rest/api/2/pages/:id/unarchive', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const page = id ? await loadPage(user, id) : null;
  if (!page) return c.json(notFound(), 404);
  if (!page.canEdit) return c.json({ errorMessages: ['Forbidden'] }, 403);
  const at = page.row.archivedAt;
  if (!at) return c.json({ id: page.row.id, archived: false, count: 0 });
  // The page and the descendants archived together with it; a page whose parent is still archived goes to the top level.
  let parentId = page.row.parentId;
  if (parentId !== null) {
    const [parent] = await db.select({ archivedAt: schema.pages.archivedAt }).from(schema.pages).where(eq(schema.pages.id, parentId)).limit(1);
    if (!parent || parent.archivedAt) parentId = null;
  }
  const scope = await db.select({ id: schema.pages.id, parentId: schema.pages.parentId, position: schema.pages.position, title: schema.pages.title, archivedAt: schema.pages.archivedAt })
    .from(schema.pages).where(scopeWhere(page.row.projectId));
  const together = descendantIds(scope, page.row.id).filter((d) => scope.find((s) => s.id === d)?.archivedAt?.getTime() === at.getTime());
  await db.update(schema.pages).set({ archivedAt: null }).where(inArray(schema.pages.id, [page.row.id, ...together]));
  if (parentId !== page.row.parentId) await db.update(schema.pages).set({ parentId }).where(eq(schema.pages.id, page.row.id));
  return c.json({ id: page.row.id, archived: false, count: together.length + 1 });
});

/* ------------------------------ versions ------------------------------ */

app.get('/rest/api/2/pages/:id/versions', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const page = id ? await loadPage(user, id) : null;
  if (!page) return c.json(notFound(), 404);
  const rows = await db
    .select({
      version: schema.pageVersions.version, title: schema.pageVersions.title, authorId: schema.pageVersions.authorId, authorName: schema.users.displayName,
      addedLines: schema.pageVersions.addedLines, removedLines: schema.pageVersions.removedLines, restoredFrom: schema.pageVersions.restoredFrom,
      createdAt: schema.pageVersions.createdAt, size: sql<number>`length(${schema.pageVersions.body})`,
    })
    .from(schema.pageVersions)
    .leftJoin(schema.users, eq(schema.users.id, schema.pageVersions.authorId))
    .where(eq(schema.pageVersions.pageId, page.row.id))
    .orderBy(desc(schema.pageVersions.version))
    .limit(500);
  return c.json({
    current: page.row.version,
    versions: rows.map((r) => ({
      version: r.version, title: r.title, author: r.authorId ? { id: r.authorId, displayName: r.authorName } : null,
      added: r.addedLines, removed: r.removedLines, restoredFrom: r.restoredFrom, createdAt: r.createdAt, size: Number(r.size),
    })),
  });
});

async function versionOf(pageId: number, version: number) {
  const [v] = await db.select().from(schema.pageVersions).where(and(eq(schema.pageVersions.pageId, pageId), eq(schema.pageVersions.version, version))).limit(1);
  return v;
}

/** The `:versionId` parameter is the version NUMBER of the page (1, 2, ...), not a database id. */
app.get('/rest/api/2/pages/:id/versions/:versionId', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const num = idOf(c.req.param('versionId'));
  const page = id ? await loadPage(user, id) : null;
  if (!page || !num) return c.json(notFound(), 404);
  const v = await versionOf(page.row.id, num);
  if (!v) return c.json(notFound('Version'), 404);
  // ?compare=current diffs against the live page, otherwise against the previous version.
  const against = c.req.query('compare') === 'current' ? { title: page.row.title, body: page.row.body, label: 'current' } : await (async () => {
    const prev = num > 1 ? await versionOf(page.row.id, num - 1) : undefined;
    return { title: prev?.title ?? '', body: prev?.body ?? '', label: prev ? `v${prev.version}` : 'empty' };
  })();
  // For "current" the direction is: what restoring this version would change (current -> this version).
  const ops = diffLines(against.body, v.body);
  return c.json({
    version: v.version, title: v.title, body: v.body, authorId: v.authorId, createdAt: v.createdAt, restoredFrom: v.restoredFrom,
    isCurrent: v.version === page.row.version,
    compared: against.label,
    titleChanged: against.title !== v.title ? { from: against.title, to: v.title } : null,
    summary: summarizeDiff(ops),
    diff: collapseDiff(ops, 3),
  });
});

app.post('/rest/api/2/pages/:id/versions/:versionId/restore', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const num = idOf(c.req.param('versionId'));
  const page = id ? await loadPage(user, id) : null;
  if (!page || !num) return c.json(notFound(), 404);
  if (!page.canEdit) return c.json({ errorMessages: ['Forbidden'] }, 403);
  if (page.row.archivedAt) return c.json({ errorMessages: ['The page is archived; restore it first'] }, 409);
  const v = await versionOf(page.row.id, num);
  if (!v) return c.json(notFound('Version'), 404);
  if (v.title === page.row.title && v.body === page.row.body) return c.json({ id: page.row.id, version: page.row.version, changed: false });
  const row = await writeVersion(page.row, user, { title: v.title, body: v.body }, v.version);
  if (!row) return c.json(conflict(page.row.version), 409);
  return c.json({ id: row.id, version: row.version, changed: true });
});

/* ------------------------------ comments ------------------------------ */

const commentBody = z.object({
  body: z.string().trim().min(1).max(20_000),
  parentId: z.number().int().positive().nullable().optional(),
  quote: z.string().trim().max(2_000).nullable().optional(),
}).strict();
const commentEdit = z.object({ body: z.string().trim().min(1).max(20_000) }).strict();

app.get('/rest/api/2/pages/:id/comments', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const page = id ? await loadPage(user, id) : null;
  if (!page) return c.json(notFound(), 404);
  const rows = await db
    .select({ c: schema.pageComments, authorName: schema.users.displayName })
    .from(schema.pageComments)
    .leftJoin(schema.users, eq(schema.users.id, schema.pageComments.authorId))
    .where(eq(schema.pageComments.pageId, page.row.id))
    .orderBy(asc(schema.pageComments.id))
    .limit(1000);
  return c.json({
    comments: rows.map((r) => ({
      id: r.c.id, parentId: r.c.parentId, body: r.c.body, quote: r.c.quote, createdAt: r.c.createdAt, updatedAt: r.c.updatedAt,
      author: r.c.authorId ? { id: r.c.authorId, displayName: r.authorName } : null,
      canEdit: r.c.authorId === user.id, canDelete: r.c.authorId === user.id || page.canModerate,
    })),
  });
});

app.post('/rest/api/2/pages/:id/comments', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const page = id ? await loadPage(user, id) : null;
  if (!page) return c.json(notFound(), 404);
  if (!page.canComment) return c.json({ errorMessages: ['Forbidden'] }, 403);
  const parsed = commentBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(badRequest(parsed.error), 400);
  const b = parsed.data;
  if (b.parentId) {
    const [parent] = await db.select().from(schema.pageComments).where(and(eq(schema.pageComments.id, b.parentId), eq(schema.pageComments.pageId, page.row.id))).limit(1);
    if (!parent) return c.json({ errorMessages: ['Parent comment not found'] }, 400);
    if (parent.parentId) return c.json({ errorMessages: ['Replies can only be added to top-level comments'] }, 400);
  }
  const [row] = await db.insert(schema.pageComments).values({ pageId: page.row.id, parentId: b.parentId ?? null, authorId: user.id, body: b.body, quote: b.quote || null }).returning();
  return c.json({ id: row.id }, 201);
});

async function loadComment(pageId: number, commentId: number) {
  const [row] = await db.select().from(schema.pageComments).where(and(eq(schema.pageComments.id, commentId), eq(schema.pageComments.pageId, pageId))).limit(1);
  return row;
}

app.put('/rest/api/2/pages/:id/comments/:commentId', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const cid = idOf(c.req.param('commentId'));
  const page = id ? await loadPage(user, id) : null;
  const comment = page && cid ? await loadComment(page.row.id, cid) : null;
  if (!page || !comment) return c.json(notFound('Comment'), 404);
  if (comment.authorId !== user.id) return c.json({ errorMessages: ['Only the author can edit a comment'] }, 403);
  const parsed = commentEdit.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(badRequest(parsed.error), 400);
  await db.update(schema.pageComments).set({ body: parsed.data.body, updatedAt: new Date() }).where(eq(schema.pageComments.id, comment.id));
  return c.json({ id: comment.id });
});

app.delete('/rest/api/2/pages/:id/comments/:commentId', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const cid = idOf(c.req.param('commentId'));
  const page = id ? await loadPage(user, id) : null;
  const comment = page && cid ? await loadComment(page.row.id, cid) : null;
  if (!page || !comment) return c.json(notFound('Comment'), 404);
  if (comment.authorId !== user.id && !page.canModerate) return c.json({ errorMessages: ['Forbidden'] }, 403);
  await db.delete(schema.pageComments).where(eq(schema.pageComments.id, comment.id)); // replies go with it (cascade)
  return c.json({});
});

/* ------------------------------ convert highlighted text to an issue ------------------------------ */

const convertBody = z.object({
  projectKey: z.string().trim().min(1).max(50),
  text: z.string().trim().min(1).max(20_000),
  summary: z.string().trim().min(1).max(255).optional(),
  issueTypeId: z.number().int().positive().optional(),
  priorityId: z.number().int().positive().optional(),
}).strict();

/** First non-empty line of the selection, stripped of Markdown markers, as the default issue summary. */
export function summaryFromText(text: string): string {
  const line = text.split('\n').map((l) => l.replace(/^[\s>#*\-+\d.)\[\]xX]+/, '').trim()).find((l) => l) ?? text.trim();
  return line.length > 255 ? `${line.slice(0, 252)}...` : line;
}

app.post('/rest/api/2/pages/:id/convert-to-issue', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idOf(c.req.param('id'));
  const page = id ? await loadPage(user, id) : null;
  if (!page) return c.json(notFound(), 404);
  const parsed = convertBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(badRequest(parsed.error), 400);
  const b = parsed.data;
  const project = await projectOf(b.projectKey);
  const admin = page.facts.isAdmin;
  if (!project || (!admin && !(await checkProjectPermission(user, project.id, 'BROWSE_PROJECTS')))) return c.json(notFound('Project'), 404);
  if (!admin && !(await checkProjectPermission(user, project.id, 'CREATE_ISSUES'))) return c.json({ errorMessages: ['Forbidden'] }, 403);

  let issueTypeId = b.issueTypeId;
  if (!issueTypeId) {
    const [t] = await db.select({ id: schema.issueTypes.id }).from(schema.issueTypes).where(eq(schema.issueTypes.isSubtask, false)).orderBy(asc(schema.issueTypes.id)).limit(1);
    if (!t) return c.json({ errorMessages: ['No issue type is available'] }, 400);
    issueTypeId = t.id;
  }
  let issue;
  try {
    issue = await createIssue({
      projectId: project.id, issueTypeId, priorityId: b.priorityId,
      summary: b.summary ?? summaryFromText(b.text),
      description: `${b.text}\n\n---\nCreated from the page [${page.row.title.replace(/[\[\]]/g, '')}](/pages/${page.row.id}).`,
    }, user.id);
  } catch (e: any) {
    return c.json({ errorMessages: [e?.message || 'Failed to create the issue'] }, 400);
  }
  await db.insert(schema.pageIssueLinks).values({ pageId: page.row.id, issueId: issue.id, quote: b.text.slice(0, 2_000), createdBy: user.id }).onConflictDoNothing();
  await invalidateIssueCache();
  publishIssue('issue.created', issue, user.id);
  try { await notifyIssueCreated(issue); } catch (e) { console.error('[pages] notification failed:', e); }
  return c.json({ issue: { id: issue.id, key: issue.key } }, 201);
});

export default app;
