/**
 * Optional JQL filter on SLA goals. Evaluated with the existing JQL engine against the issues table,
 * so a goal can use anything the engine can express (labels, components, assignee, status, ...).
 */
import { and, inArray } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { parseJQLSafe, type JQLContext } from '../jql'

export async function jqlContext(): Promise<JQLContext> {
  const [statuses, priorities, issueTypes, projects, users, resolutions] = await Promise.all([
    db.select().from(schema.statuses), db.select().from(schema.priorities), db.select().from(schema.issueTypes),
    db.select().from(schema.projects), db.select().from(schema.users), db.select().from(schema.resolutions),
  ])
  return {
    statusNames: Object.fromEntries(statuses.map((s) => [s.name.toLowerCase(), s.id])),
    priorityNames: Object.fromEntries(priorities.map((p) => [p.name.toLowerCase(), p.id])),
    issueTypeNames: Object.fromEntries(issueTypes.map((t) => [t.name.toLowerCase(), t.id])),
    projectKeys: Object.fromEntries(projects.map((p) => [p.projectKey.toLowerCase(), p.id])),
    projectNames: Object.fromEntries(projects.map((p) => [p.name.toLowerCase(), p.id])),
    userNames: Object.fromEntries(users.map((u) => [u.username.toLowerCase(), u.id])),
    resolutionNames: Object.fromEntries(resolutions.map((r) => [r.name.toLowerCase(), r.id])),
    groupMembers: {}, openSprintIds: [], closedSprintIds: [],
  } as JQLContext // resolutionNames is read by the translator but missing from the exported type
}

/** Returns an error message if the JQL cannot be parsed by the engine. */
export async function validateGoalJql(jql: string): Promise<string | null> {
  const parsed = parseJQLSafe(jql, await jqlContext())
  return parsed.success ? null : parsed.error
}

/** For each JQL string: the subset of `issueIds` it matches. Invalid JQL matches nothing. */
export async function evaluateGoalJql(jqls: string[], issueIds: number[]): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>()
  const distinct = [...new Set(jqls)]
  if (distinct.length === 0 || issueIds.length === 0) return out
  const ctx = await jqlContext()
  for (const jql of distinct) {
    const parsed = parseJQLSafe(jql, ctx)
    if (!parsed.success) { out.set(jql, new Set()); continue }
    try {
      const rows = await db.select({ id: schema.issues.id }).from(schema.issues)
        .where(and(inArray(schema.issues.id, issueIds), parsed.result.where))
      out.set(jql, new Set(rows.map((r) => r.id)))
    } catch (e) {
      console.error('[servicedesk] goal JQL evaluation failed', e)
      out.set(jql, new Set())
    }
  }
  return out
}
