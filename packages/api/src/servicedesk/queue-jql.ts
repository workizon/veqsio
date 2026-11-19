/**
 * Service desk queues are ordinary JQL evaluated by the real JQL engine (the same translator the issue search uses),
 * scoped to the desk's project. The queue's ORDER BY is its sort.
 */
import { issueVisibleSql } from '../security/issue-security'
import { and, eq, desc, type SQL } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { tokenize, parseJQLTokens, translateJQL, JQLError, type JQLContext } from '../jql'

export type QueueJqlResult =
  | { ok: true; where: SQL | undefined; orderBy: SQL[] }
  | { ok: false; message: string; pos: number | null }

/** Parse a queue's JQL. Never throws; reports the parser's message and character position on failure. */
export function compileQueueJql(jql: string | null | undefined, ctx: JQLContext): QueueJqlResult {
  const text = (jql ?? '').trim()
  if (!text) return { ok: true, where: undefined, orderBy: [] }
  try {
    const r = translateJQL(parseJQLTokens(tokenize(text)), ctx)
    return { ok: true, where: r.where, orderBy: r.orderBy ?? [] }
  } catch (e) {
    if (e instanceof JQLError) return { ok: false, message: e.message, pos: e.pos ?? null }
    return { ok: false, message: e instanceof Error ? e.message : String(e), pos: null }
  }
}

/** WHERE for the issues of a desk's project narrowed by a queue's compiled JQL (always scoped to the desk's project). */
export function queueScope(deskProjectId: number, compiled: Extract<QueueJqlResult, { ok: true }>, viewerId: number): SQL {
  // The viewer's issue security levels apply to every queue and count.
  const project = and(eq(schema.issues.projectId, deskProjectId), issueVisibleSql(viewerId))!
  return compiled.where ? and(project, compiled.where)! : project
}

/** ORDER BY for a queue; the issue id is a tie-breaker so OFFSET pagination is stable. */
export function queueOrder(compiled: Extract<QueueJqlResult, { ok: true }>): SQL[] {
  return compiled.orderBy.length > 0
    ? [...compiled.orderBy, desc(schema.issues.id)]
    : [desc(schema.issues.createdAt), desc(schema.issues.id)]
}
