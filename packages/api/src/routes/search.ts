import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, or, like, desc, count, and, inArray } from 'drizzle-orm';
import { buildIssueResponse, buildIssueResponses } from '../issues/service';
import { cacheMiddleware } from '../middleware/cache';
import * as cache from '../services/cache';
import { searchIssues } from '../search/fulltext';
import { parseJQLSafe } from '../jql';
import type { JQLContext } from '../jql';
import { getSearchableProjectIds } from '../services/browse';
import { issueVisibleSql, redactIssueResponses } from '../security/issue-security';
import type { AppContext } from '../auth/middleware';

const app = new Hono<AppContext>();
app.use('/rest/api/2/search', sessionMiddleware);

class MemoryTTLCache<T> {
  private store = new Map<string, { value: T; expiry: number }>();

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlSeconds: number): void {
    this.store.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 });
  }

  invalidate(): void {
    this.store.clear();
  }
}

const jqlContextCache = new MemoryTTLCache<JQLContext>();

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return String(hash);
}

export async function buildJQLContext(user: any): Promise<JQLContext> {
  const cached = jqlContextCache.get('jql-context');
  if (cached) {
    return { ...cached, currentUserId: user?.id };
  }

  const [statuses, priorities, issueTypes, projects, users, resolutions, cfields, cfRefs] = await Promise.all([
    db.select().from(schema.statuses),
    db.select().from(schema.priorities),
    db.select().from(schema.issueTypes),
    db.select().from(schema.projects),
    db.select().from(schema.users),
    db.select().from(schema.resolutions),
    db.select({ id: schema.customFields.id, name: schema.customFields.name }).from(schema.customFields),
    db.select({ externalId: schema.migrationExternalRefs.externalId, localId: schema.migrationExternalRefs.localId }).from(schema.migrationExternalRefs)
      .where(and(eq(schema.migrationExternalRefs.source, 'jira'), eq(schema.migrationExternalRefs.entityType, 'customfield'))),
  ]);

  const ctx: JQLContext = {
    currentUserId: user?.id,
    statusNames: Object.fromEntries(statuses.map((s) => [s.name.toLowerCase(), s.id])),
    priorityNames: Object.fromEntries(priorities.map((p) => [p.name.toLowerCase(), p.id])),
    issueTypeNames: Object.fromEntries(issueTypes.map((t) => [t.name.toLowerCase(), t.id])),
    projectKeys: Object.fromEntries(projects.map((p) => [p.projectKey.toLowerCase(), p.id])),
    projectNames: Object.fromEntries(projects.map((p) => [p.name.toLowerCase(), p.id])),
    userNames: Object.fromEntries(users.map((u) => [u.username.toLowerCase(), u.id])),
    resolutionNames: Object.fromEntries(resolutions.map((r) => [r.name.toLowerCase(), r.id])),
    customFieldNames: Object.fromEntries(cfields.map((f) => [f.name.toLowerCase(), f.id])),
    customFieldJiraIds: Object.fromEntries(cfRefs.map((r) => [Number(r.externalId.replace('customfield_', '')), r.localId])),
    groupMembers: {},
    openSprintIds: [],
    closedSprintIds: [],
  };

  // Names -> ids for JQL. Short TTL: a project/user/status created a moment ago must be usable in JQL almost at once
  // (it used to be 60 s). Disabled under test so fixtures that are truncated between files cannot go stale.
  const ttl = process.env.NODE_ENV === 'test' ? 0 : Number(process.env.JQL_CONTEXT_TTL_SECONDS ?? 5);
  jqlContextCache.set('jql-context', ctx, ttl);
  return ctx;
}

/** Parse an integer query parameter, falling back to `def` for missing/invalid input and clamping to [min, max]. */
export function intParam(v: string | undefined, def: number, min: number, max: number): number {
  const n = v === undefined || v === '' ? def : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Hard limits for search pagination: a page is at most MAX_PAGE_SIZE issues and OFFSET at most MAX_START_AT. */
export const MAX_PAGE_SIZE = 1000;
export const MAX_START_AT = 100_000;

app.get('/rest/api/2/search', requireAuth, cacheMiddleware(60), async (c) => {
  try {
    const jql = c.req.query('jql') || '';
    const text = c.req.query('text') || '';
    const startAt = intParam(c.req.query('startAt'), 0, 0, MAX_START_AT);
    const maxResults = intParam(c.req.query('maxResults'), 50, 0, MAX_PAGE_SIZE);
    const user = c.get('user');

    // If text query is provided without JQL, use full-text search (only in projects the caller may browse)
    if (text && !jql) {
      const browsable = await getSearchableProjectIds(user!, jql, c.req.query('includeArchived') === 'true');
      const results = await searchIssues(text, browsable, user!.id);
      const paginated = results.slice(startAt, startAt + maxResults);
      const responses = await redactIssueResponses(user!.id, await buildIssueResponses(paginated.map((r) => r.id)));
      return c.json({
        expand: 'names,schema',
        startAt,
        maxResults,
        total: results.length,
        issues: responses,
      });
    }

    // If JQL is provided, use the JQL parser
    if (jql) {
      const jqlCacheKey = `veqsio:search:${user?.id ?? 'anon'}:g${await cache.generation('search')}.${await cache.generation('security')}:${simpleHash(jql)}:${startAt}:${maxResults}`;
      const cachedSearch = await cache.get<any>(jqlCacheKey);
      if (cachedSearch) {
        return c.json(cachedSearch);
      }

      const ctx = await buildJQLContext(user);
      const parsed = parseJQLSafe(jql, ctx);

      if (!parsed.success) {
        return c.json({ errorMessages: [parsed.error] }, 400);
      }

      const { where, orderBy, limit: jqlLimit } = parsed.result;

      // Permission trimming: only issues in projects the caller may browse.
      const browsable = await getSearchableProjectIds(user!, jql, c.req.query('includeArchived') === 'true');
      const secure = issueVisibleSql(user!.id);
      const scope = where ? and(where, inArray(schema.issues.projectId, browsable), secure) : and(inArray(schema.issues.projectId, browsable), secure);
      // Count and page in the database (previously every matching row was loaded and sliced in memory).
      // `id` is a tie-breaker so OFFSET pagination is stable.
      const order = orderBy && orderBy.length > 0 ? [...orderBy, desc(schema.issues.id)] : [desc(schema.issues.createdAt), desc(schema.issues.id)];
      // `LIMIT n` in the JQL caps the whole result set; maxResults / startAt still page through those n issues.
      const pageSize = jqlLimit === undefined ? maxResults : Math.max(0, Math.min(maxResults, jqlLimit - startAt));
      const [pageRows, totalRows] = await Promise.all([
        pageSize === 0 ? Promise.resolve([] as Array<{ id: number }>) : db.select({ id: schema.issues.id }).from(schema.issues).where(scope).orderBy(...order).limit(pageSize).offset(startAt),
        db.select({ count: count() }).from(schema.issues).where(scope),
      ]);
      const responses = await redactIssueResponses(user!.id, await buildIssueResponses(pageRows.map((i) => i.id)));

      const result = {
        expand: 'names,schema',
        startAt,
        maxResults,
        total: jqlLimit === undefined ? Number(totalRows[0]?.count || 0) : Math.min(jqlLimit, Number(totalRows[0]?.count || 0)),
        issues: responses,
      };

      await cache.set(jqlCacheKey, result, 'search');
      return c.json(result);
    }

    // No JQL or text — return all issues
    const browsable = await getSearchableProjectIds(user!, jql, c.req.query('includeArchived') === 'true');
    const [issues, totalResult] = await Promise.all([
      db.select({ id: schema.issues.id }).from(schema.issues)
        .where(and(inArray(schema.issues.projectId, browsable), issueVisibleSql(user!.id)))
        .orderBy(desc(schema.issues.createdAt), desc(schema.issues.id))
        .limit(maxResults)
        .offset(startAt),
      db.select({ count: count() }).from(schema.issues).where(and(inArray(schema.issues.projectId, browsable), issueVisibleSql(user!.id))),
    ]);
    const responses = await redactIssueResponses(user!.id, await buildIssueResponses(issues.map((i) => i.id)));

    return c.json({
      expand: 'names,schema',
      startAt,
      maxResults,
      total: Number(totalResult[0]?.count || 0),
      issues: responses,
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Search failed'] }, 500);
  }
});

export default app;
