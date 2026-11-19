import { reportCategory } from '../workflow/status-groups'
/**
 * Permission-scoped issue loading for gadget data endpoints. Every query is restricted to projects the viewer
 * may browse (getBrowsableProjectIds), and JQL goes through the same engine as the search page.
 */
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import * as schema from '@veqsio/db'
import { db } from '../db'
import { getBrowsableProjectIds } from '../middleware/permissions'
import { issueVisibleSql } from '../security/issue-security'
import { parseJQLSafe } from '../jql'
import { jqlContext } from '../servicedesk/goal-filter'
import type { GadgetRow } from './gadget-data'

type User = typeof schema.users.$inferSelect

export class GadgetQueryError extends Error {
  constructor(message: string, public status: 400 | 404 = 400) {
    super(message)
  }
}

export interface SourceOpts {
  jql?: string
  filterId?: string
}

/** The JQL text of a gadget source: explicit JQL wins, otherwise the saved filter's JQL, otherwise everything. */
export async function resolveSourceJql(src: SourceOpts): Promise<string> {
  if (src.jql && src.jql.trim()) return src.jql.trim()
  if (src.filterId && /^\d+$/.test(src.filterId)) {
    const [f] = await db.select().from(schema.filters).where(eq(schema.filters.id, Number(src.filterId))).limit(1)
    if (!f) throw new GadgetQueryError('Saved filter not found', 404)
    return f.jql
  }
  return ''
}

export interface LoadOpts extends SourceOpts {
  limit?: number
  /** Load labels / components / fix versions (only needed when grouping by them). */
  multi?: boolean
  /** Order override when the JQL has no ORDER BY. */
  defaultOrder?: 'created' | 'updated'
  /** Extra SQL condition ANDed to the JQL (still inside the browsable-project scope). */
  extra?: SQL
}

export async function loadScopedRows(user: User, opts: LoadOpts): Promise<{ rows: GadgetRow[]; jql: string; total: number }> {
  const jql = await resolveSourceJql(opts)
  const projectIds = await getBrowsableProjectIds(user)
  if (projectIds.length === 0) return { rows: [], jql, total: 0 }

  const ctx = { ...(await jqlContext()), currentUserId: user.id }
  let where: any = undefined
  let orderBy: any[] = []
  if (jql) {
    const parsed = parseJQLSafe(jql, ctx)
    if (!parsed.success) throw new GadgetQueryError(parsed.error, 400)
    where = parsed.result.where
    orderBy = parsed.result.orderBy ?? []
  }
  const scope = inArray(schema.issues.projectId, projectIds)
  const cond = and(scope, issueVisibleSql(user.id), where, opts.extra)!
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 5000)

  const reporter = alias(schema.users, 'gadget_reporter')
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.issues).where(cond)
  const order = orderBy.length ? orderBy : [opts.defaultOrder === 'updated' ? desc(schema.issues.updatedAt) : desc(schema.issues.createdAt)]
  const found = await db
    .select({
      issue: schema.issues,
      status: schema.statuses.name,
      category: schema.statuses.category,
      priority: schema.priorities.name,
      type: schema.issueTypes.name,
      assignee: schema.users.displayName,
      reporter: reporter.displayName,
      resolution: schema.resolutions.name,
      project: schema.projects.name,
      projectKey: schema.projects.projectKey,
    })
    .from(schema.issues)
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.issues.projectId))
    .leftJoin(schema.priorities, eq(schema.priorities.id, schema.issues.priorityId))
    .leftJoin(schema.users, eq(schema.users.id, schema.issues.assigneeId))
    .leftJoin(reporter, eq(reporter.id, schema.issues.reporterId))
    .leftJoin(schema.resolutions, eq(schema.resolutions.id, schema.issues.resolutionId))
    .where(cond)
    .orderBy(...order)
    .limit(limit)

  const ids = found.map((f) => f.issue.id)
  const labels = new Map<number, string[]>()
  const components = new Map<number, string[]>()
  const versions = new Map<number, string[]>()
  if (opts.multi && ids.length) {
    const push = (m: Map<number, string[]>, id: number, v: string) => m.set(id, [...(m.get(id) ?? []), v])
    const [l, c, v] = await Promise.all([
      db.select({ id: schema.issueLabels.issueId, name: schema.labels.name }).from(schema.issueLabels)
        .innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId)).where(inArray(schema.issueLabels.issueId, ids)),
      db.select({ id: schema.issueComponents.issueId, name: schema.components.name }).from(schema.issueComponents)
        .innerJoin(schema.components, eq(schema.components.id, schema.issueComponents.componentId)).where(inArray(schema.issueComponents.issueId, ids)),
      db.select({ id: schema.issueFixVersions.issueId, name: schema.versions.name }).from(schema.issueFixVersions)
        .innerJoin(schema.versions, eq(schema.versions.id, schema.issueFixVersions.versionId)).where(inArray(schema.issueFixVersions.issueId, ids)),
    ])
    l.forEach((r) => push(labels, r.id, r.name))
    c.forEach((r) => push(components, r.id, r.name))
    v.forEach((r) => push(versions, r.id, r.name))
  }

  const rows: GadgetRow[] = found.map((f) => ({
    id: f.issue.id,
    key: f.issue.issueKey,
    summary: f.issue.summary,
    status: f.status,
    statusCategory: reportCategory(f.category),
    priority: f.priority,
    type: f.type,
    assignee: f.assignee,
    reporter: f.reporter,
    resolution: f.resolution,
    project: f.project,
    projectKey: f.projectKey,
    labels: labels.get(f.issue.id) ?? [],
    components: components.get(f.issue.id) ?? [],
    fixVersions: versions.get(f.issue.id) ?? [],
    createdAt: f.issue.createdAt,
    updatedAt: f.issue.updatedAt,
    resolvedAt: f.issue.resolvedAt,
    dueDate: f.issue.dueDate,
    timeEstimate: f.issue.timeEstimate,
    timeSpent: f.issue.timeSpent,
  }))
  return { rows, jql, total: n }
}

/** Validate a JQL string against the engine. Returns an error message or null. */
export async function checkJql(jql: string): Promise<string | null> {
  const parsed = parseJQLSafe(jql, { ...(await jqlContext()), currentUserId: 0 })
  return parsed.success ? null : parsed.error
}
