/**
 * Runs a view configuration AS THE VIEWER. The query is always intersected with the projects the viewer can
 * browse, so neither a shared view nor an export can reveal an issue the caller may not see.
 */
import { and, count, desc, inArray, sql, type SQL } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { parseJQLSafe } from '../jql';
import { buildJQLContext } from '../routes/search';
import { getBrowsableProjectIds } from '../services/browse';
import { buildIssueResponses } from '../issues/service';
import { buildFilterJql, type ViewConfig, type SortTerm } from './config';
import { groupIssues, type GroupKey, type GroupUniverse, type Group } from './grouping';

type User = typeof schema.users.$inferSelect;

export class ViewQueryError extends Error {}

/** Order for statuses of a category: to do, in progress, done; then the status' own sort order. */
export function statusOrder(category: string | null | undefined, sortOrder: number | null | undefined, id: number): number {
  const rank = ({ new: 0, todo: 0, indeterminate: 1, done: 2 } as Record<string, number>)[String(category ?? '').toLowerCase()] ?? 1;
  return rank * 1000 + (sortOrder ?? id);
}

/** SQL ORDER BY terms for a sort list. Always ends with a stable tie-breaker. */
export function sortTerms(sort: SortTerm[]): SQL[] {
  const i = schema.issues;
  const out: SQL[] = [];
  for (const t of sort) {
    const dir = t.direction === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
    switch (t.field) {
      case 'key': out.push(sql`(SELECT p.project_key FROM projects p WHERE p.id = ${i.projectId}) ${dir}`, sql`length(${i.issueKey}) ${dir}`, sql`${i.issueKey} ${dir}`); break;
      case 'summary': out.push(sql`lower(${i.summary}) ${dir}`); break;
      case 'type': out.push(sql`(SELECT t.name FROM issue_types t WHERE t.id = ${i.issueTypeId}) ${dir}`); break;
      case 'status': out.push(sql`(SELECT s.sort_order FROM statuses s WHERE s.id = ${i.statusId}) ${dir}`, sql`${i.statusId} ${dir}`); break;
      case 'priority': out.push(sql`(SELECT p.sort_order FROM priorities p WHERE p.id = ${i.priorityId}) ${dir}`); break;
      case 'assignee': out.push(sql`(SELECT lower(u.display_name) FROM users u WHERE u.id = ${i.assigneeId}) ${dir}`); break;
      case 'reporter': out.push(sql`(SELECT lower(u.display_name) FROM users u WHERE u.id = ${i.reporterId}) ${dir}`); break;
      case 'project': out.push(sql`(SELECT p.project_key FROM projects p WHERE p.id = ${i.projectId}) ${dir}`); break;
      case 'storyPoints': out.push(sql`${i.storyPoints} ${dir}`); break;
      case 'created': out.push(sql`${i.createdAt} ${dir}`); break;
      case 'updated': out.push(sql`${i.updatedAt} ${dir}`); break;
      case 'resolved': out.push(sql`${i.resolvedAt} ${dir}`); break;
      case 'duedate': out.push(sql`${i.dueDate} ${dir}`); break;
      case 'startdate': out.push(sql`${i.startDate} ${dir}`); break;
    }
  }
  out.push(desc(i.id));
  return out;
}

export interface Compiled { where: SQL | undefined; orderBy: SQL[] }

/** JQL + simple filters -> SQL condition (AND of both) and the JQL ORDER BY of the base query. */
export async function compileQuery(user: User, query: ViewConfig['query']): Promise<Compiled> {
  const ctx = await buildJQLContext(user);
  const conds: SQL[] = [];
  let orderBy: SQL[] = [];
  const base = query.jql.trim();
  if (base) {
    const p = parseJQLSafe(base, ctx);
    if (!p.success) throw new ViewQueryError(`Invalid JQL: ${p.error}`);
    if (p.result.where) conds.push(p.result.where);
    orderBy = p.result.orderBy ?? [];
  }
  const filterJql = buildFilterJql(query.filters);
  if (filterJql) {
    const p = parseJQLSafe(filterJql, ctx);
    if (!p.success) throw new ViewQueryError(`Invalid filter: ${p.error}`);
    if (p.result.where) conds.push(p.result.where);
  }
  return { where: conds.length ? and(...conds) : undefined, orderBy };
}

async function scope(user: User, query: ViewConfig['query']) {
  const compiled = await compileQuery(user, query);
  const browsable = await getBrowsableProjectIds(user);
  const permitted = inArray(schema.issues.projectId, browsable);
  return { where: compiled.where ? and(compiled.where, permitted)! : permitted, jqlOrder: compiled.orderBy };
}

function orderFor(config: ViewConfig, jqlOrder: SQL[]): SQL[] {
  if (config.sort.length) return sortTerms(config.sort);
  if (jqlOrder.length) return [...jqlOrder, desc(schema.issues.id)];
  return [desc(schema.issues.createdAt), desc(schema.issues.id)];
}

/** Adds `fields.sprint` (the issue's active sprint, else a future one, else the most recent) to each issue. */
async function attachSprints(issues: Array<{ id: number; fields: Record<string, any> }>): Promise<void> {
  if (!issues.length) return;
  const rows = await db.select({ issueId: schema.sprintIssues.issueId, id: schema.sprints.id, name: schema.sprints.name, state: schema.sprints.state })
    .from(schema.sprintIssues)
    .innerJoin(schema.sprints, sql`${schema.sprints.id} = ${schema.sprintIssues.sprintId}`)
    .where(inArray(schema.sprintIssues.issueId, issues.map((i) => i.id)));
  const rank = (s: string | null) => (s === 'active' ? 0 : s === 'future' ? 1 : 2);
  const best = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = best.get(r.issueId);
    if (!cur || rank(r.state) < rank(cur.state) || (rank(r.state) === rank(cur.state) && r.id > cur.id)) best.set(r.issueId, r);
  }
  for (const i of issues) {
    const s = best.get(i.id);
    i.fields.sprint = s ? { id: s.id, name: s.name, state: s.state } : null;
  }
}

async function loadUniverse(config: ViewConfig): Promise<GroupUniverse> {
  const fields = new Set([config.groupBy, config.subGroupBy]);
  const u: GroupUniverse = {};
  if (fields.has('status')) {
    const rows = await db.select().from(schema.statuses);
    u.status = rows.map((s): GroupKey => ({ key: `status:${s.id}`, label: s.name, order: statusOrder(s.category, s.sortOrder, s.id) }));
  }
  if (fields.has('priority')) {
    const rows = await db.select().from(schema.priorities);
    u.priority = rows.map((p): GroupKey => ({ key: `priority:${p.id}`, label: p.name, order: p.sortOrder ?? p.id }));
  }
  if (fields.has('type')) {
    const rows = await db.select().from(schema.issueTypes);
    u.type = rows.map((t): GroupKey => ({ key: `type:${t.id}`, label: t.name, order: t.id }));
  }
  return u;
}

export interface ViewExecution {
  startAt: number;
  maxResults: number;
  total: number;
  issues: Array<{ id: number; key: string; fields: Record<string, any> }>;
  groupBy: ViewConfig['groupBy'];
  subGroupBy: ViewConfig['subGroupBy'];
  showEmptyGroups: boolean;
  /** Groups of the issues on THIS page (`count` is per page). */
  groups: Group[];
}

export const MAX_VIEW_PAGE = 500;

export async function executeView(user: User, config: ViewConfig, startAt: number, maxResults: number): Promise<ViewExecution> {
  const { where, jqlOrder } = await scope(user, config.query);
  const [ids, totalRows] = await Promise.all([
    db.select({ id: schema.issues.id }).from(schema.issues).where(where)
      .orderBy(...orderFor(config, jqlOrder)).limit(maxResults).offset(startAt),
    db.select({ n: count() }).from(schema.issues).where(where),
  ]);
  const issues = await buildIssueResponses(ids.map((r) => r.id));
  await attachSprints(issues);
  const universe = await loadUniverse(config);
  const groups = groupIssues(issues, config.groupBy, config.subGroupBy, { showEmpty: config.showEmptyGroups, universe });
  return {
    startAt, maxResults, total: Number(totalRows[0]?.n ?? 0), issues,
    groupBy: config.groupBy, subGroupBy: config.subGroupBy, showEmptyGroups: config.showEmptyGroups, groups,
  };
}

/**
 * Ids for an export (at most `limit`, in view order) and whether more rows exist. Rows are then loaded in chunks
 * by `loadExportChunk` so memory stays bounded and the response can be streamed.
 */
export async function exportIds(user: User, config: ViewConfig, limit: number): Promise<{ ids: number[]; truncated: boolean }> {
  const { where, jqlOrder } = await scope(user, config.query);
  const rows = await db.select({ id: schema.issues.id }).from(schema.issues).where(where)
    .orderBy(...orderFor(config, jqlOrder)).limit(limit + 1);
  return { ids: rows.slice(0, limit).map((r) => r.id), truncated: rows.length > limit };
}

export async function loadExportChunk(ids: number[]) {
  const issues = await buildIssueResponses(ids);
  await attachSprints(issues);
  return issues;
}


