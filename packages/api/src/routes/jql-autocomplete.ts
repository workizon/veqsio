import { issueVisibleSql } from '../security/issue-security';
import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { and, eq, ilike, inArray } from 'drizzle-orm';
import { checkProjectPermission } from '../middleware/permissions';
import {
  AUTOCOMPLETE_FIELDS,
  AUTOCOMPLETE_FUNCTIONS,
  JQL_RESERVED_WORDS,
  SUGGESTIBLE_FIELDS,
  filterAndRank,
} from '../jql/autocomplete-data';
import type { AppContext } from '../auth/middleware';

const app = new Hono<AppContext>();
app.use('/rest/api/2/jql/*', sessionMiddleware);

const MAX_SUGGESTIONS = 20;

/** Escape LIKE wildcards in user input. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Projects the user may browse (BROWSE_PROJECTS). */
async function browsableProjects(user: any) {
  const projects = await db.select().from(schema.projects);
  const checks = await Promise.all(
    projects.map(async (p) => ((await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS')) ? p : null)),
  );
  return checks.filter((p): p is (typeof projects)[number] => p !== null);
}

function uniqueResults(values: string[]) {
  return [...new Set(values)].map((v) => ({ value: v, displayName: v }));
}

app.get('/rest/api/2/jql/autocompletedata', requireAuth, (c) => {
  return c.json({
    visibleFieldNames: AUTOCOMPLETE_FIELDS,
    visibleFunctionNames: AUTOCOMPLETE_FUNCTIONS,
    jqlReservedWords: JQL_RESERVED_WORDS,
  });
});

app.get('/rest/api/2/jql/autocompletedata/suggestions', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const fieldName = (c.req.query('fieldName') || '').toLowerCase();
    const fieldValue = (c.req.query('fieldValue') || '').trim();

    if (!SUGGESTIBLE_FIELDS.has(fieldName)) {
      return c.json({ results: [] });
    }

    let results: { value: string; displayName: string }[] = [];

    switch (fieldName) {
      case 'status': {
        const rows = await db.select().from(schema.statuses);
        results = uniqueResults(rows.map((r) => r.name));
        break;
      }
      case 'priority': {
        const rows = await db.select().from(schema.priorities);
        results = uniqueResults(rows.map((r) => r.name));
        break;
      }
      case 'issuetype': {
        const rows = await db.select().from(schema.issueTypes);
        results = uniqueResults(rows.map((r) => r.name));
        break;
      }
      case 'resolution': {
        const rows = await db.select().from(schema.resolutions);
        results = uniqueResults(rows.map((r) => r.name));
        break;
      }
      case 'assignee':
      case 'reporter': {
        const rows = await db.select().from(schema.users).where(eq(schema.users.active, true));
        results = rows.map((u) => ({
          value: u.username,
          displayName: `${u.displayName} (${u.username})`,
        }));
        break;
      }
      case 'project': {
        const projects = await browsableProjects(user);
        results = projects.map((p) => ({ value: p.projectKey, displayName: `${p.name} (${p.projectKey})` }));
        break;
      }
      case 'component': {
        const ids = (await browsableProjects(user)).map((p) => p.id);
        if (ids.length === 0) break;
        const rows = await db
          .select({ name: schema.components.name })
          .from(schema.components)
          .where(inArray(schema.components.projectId, ids));
        results = uniqueResults(rows.map((r) => r.name));
        break;
      }
      case 'fixversion': {
        const ids = (await browsableProjects(user)).map((p) => p.id);
        if (ids.length === 0) break;
        const rows = await db
          .select({ name: schema.versions.name })
          .from(schema.versions)
          .where(inArray(schema.versions.projectId, ids));
        results = uniqueResults(rows.map((r) => r.name));
        break;
      }
      case 'labels': {
        const ids = (await browsableProjects(user)).map((p) => p.id);
        if (ids.length === 0) break;
        const rows = await db
          .selectDistinct({ name: schema.labels.name })
          .from(schema.issueLabels)
          .innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId))
          .innerJoin(schema.issues, eq(schema.issues.id, schema.issueLabels.issueId))
          .where(
            and(
              inArray(schema.issues.projectId, ids),
              issueVisibleSql(user.id),
              fieldValue ? ilike(schema.labels.name, likePattern(fieldValue)) : undefined,
            ),
          )
          .limit(200);
        results = uniqueResults(rows.map((r) => r.name));
        break;
      }
    }

    return c.json({ results: filterAndRank(results, fieldValue, MAX_SUGGESTIONS) });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to fetch suggestions'] }, 500);
  }
});

export default app;
