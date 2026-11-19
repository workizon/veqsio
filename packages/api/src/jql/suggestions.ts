import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { getBrowsableProjectIds } from '../services/browse';
import { MAX_SUGGESTIONS } from './autocomplete';

type User = typeof schema.users.$inferSelect;

export interface ValueSuggestion {
  value: string;
  displayName: string;
}

export const SUGGESTION_FIELDS = new Set([
  'status', 'priority', 'issuetype', 'resolution', 'project', 'assignee', 'reporter', 'watcher', 'voter',
  'labels', 'component', 'components', 'fixversion', 'sprint', 'level',
]);

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Value suggestions for a JQL field, prefix-filtered, max 20. Projects, components, versions and
 * sprints are limited to projects the caller may browse; users expose only username and display name.
 */
export async function suggestValues(user: User, fieldName: string, rawPrefix: string): Promise<ValueSuggestion[]> {
  const field = fieldName.toLowerCase();
  const prefix = rawPrefix.slice(0, 100);
  const like = `${escapeLike(prefix)}%`;
  const limit = MAX_SUGGESTIONS;

  switch (field) {
    case 'status': {
      const rows = await db.select({ name: schema.statuses.name }).from(schema.statuses)
        .where(ilike(schema.statuses.name, like)).orderBy(asc(schema.statuses.name)).limit(limit);
      return rows.map((r) => ({ value: r.name, displayName: r.name }));
    }
    case 'priority': {
      const rows = await db.select({ name: schema.priorities.name }).from(schema.priorities)
        .where(ilike(schema.priorities.name, like)).orderBy(asc(schema.priorities.name)).limit(limit);
      return rows.map((r) => ({ value: r.name, displayName: r.name }));
    }
    case 'issuetype': {
      const rows = await db.select({ name: schema.issueTypes.name }).from(schema.issueTypes)
        .where(ilike(schema.issueTypes.name, like)).orderBy(asc(schema.issueTypes.name)).limit(limit);
      return rows.map((r) => ({ value: r.name, displayName: r.name }));
    }
    case 'resolution': {
      const rows = await db.select({ name: schema.resolutions.name }).from(schema.resolutions)
        .where(ilike(schema.resolutions.name, like)).orderBy(asc(schema.resolutions.name)).limit(limit);
      return rows.map((r) => ({ value: r.name, displayName: r.name }));
    }
    case 'labels': {
      const rows = await db.select({ name: schema.labels.name }).from(schema.labels)
        .where(ilike(schema.labels.name, like)).orderBy(asc(schema.labels.name)).limit(limit);
      return rows.map((r) => ({ value: r.name, displayName: r.name }));
    }
    case 'assignee':
    case 'watcher':
    case 'voter':
    case 'reporter': {
      const rows = await db.select({ username: schema.users.username, displayName: schema.users.displayName })
        .from(schema.users)
        .where(and(
          eq(schema.users.active, true),
          or(ilike(schema.users.username, like), ilike(schema.users.displayName, like)),
        ))
        .orderBy(asc(schema.users.displayName)).limit(limit);
      return rows.map((r) => ({ value: r.username, displayName: `${r.displayName} (${r.username})` }));
    }
    case 'project': {
      const ids = await getBrowsableProjectIds(user);
      if (ids.length === 0) return [];
      const rows = await db.select({ key: schema.projects.projectKey, name: schema.projects.name })
        .from(schema.projects)
        .where(and(
          inArray(schema.projects.id, ids),
          or(ilike(schema.projects.projectKey, like), ilike(schema.projects.name, like)),
        ))
        .orderBy(asc(schema.projects.projectKey)).limit(limit);
      return rows.map((r) => ({ value: r.key, displayName: `${r.name} (${r.key})` }));
    }
    case 'component':
    case 'components': {
      const ids = await getBrowsableProjectIds(user);
      if (ids.length === 0) return [];
      const rows = await db.selectDistinct({ name: schema.components.name }).from(schema.components)
        .where(and(inArray(schema.components.projectId, ids), ilike(schema.components.name, like)))
        .orderBy(asc(schema.components.name)).limit(limit);
      return rows.map((r) => ({ value: r.name, displayName: r.name }));
    }
    case 'fixversion': {
      const ids = await getBrowsableProjectIds(user);
      if (ids.length === 0) return [];
      const rows = await db.selectDistinct({ name: schema.versions.name }).from(schema.versions)
        .where(and(inArray(schema.versions.projectId, ids), ilike(schema.versions.name, like)))
        .orderBy(asc(schema.versions.name)).limit(limit);
      return rows.map((r) => ({ value: r.name, displayName: r.name }));
    }
    case 'level': {
      const ids = await getBrowsableProjectIds(user);
      if (ids.length === 0) return [];
      const rows = await db.selectDistinct({ name: schema.issueSecurityLevels.name }).from(schema.issueSecurityLevels)
        .innerJoin(schema.issueSecuritySchemeAssociations, eq(schema.issueSecuritySchemeAssociations.schemeId, schema.issueSecurityLevels.schemeId))
        .where(and(inArray(schema.issueSecuritySchemeAssociations.projectId, ids), ilike(schema.issueSecurityLevels.name, like)))
        .orderBy(asc(schema.issueSecurityLevels.name)).limit(limit);
      return rows.map((r) => ({ value: r.name, displayName: r.name }));
    }
    case 'sprint': {
      const ids = await getBrowsableProjectIds(user);
      if (ids.length === 0) return [];
      const rows = await db.select({ name: schema.sprints.name }).from(schema.sprints)
        .innerJoin(schema.boards, eq(schema.boards.id, schema.sprints.boardId))
        .where(and(inArray(schema.boards.projectId, ids), ilike(schema.sprints.name, like)))
        .orderBy(sql`${schema.sprints.id} desc`).limit(limit);
      const seen = new Set<string>();
      return rows.filter((r) => !seen.has(r.name) && seen.add(r.name)).map((r) => ({ value: r.name, displayName: r.name }));
    }
    default:
      return [];
  }
}
