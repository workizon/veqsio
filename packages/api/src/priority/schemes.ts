/**
 * Priority schemes: which priorities a project offers, and which one new issues get by default.
 * A project without a scheme offers every priority, so existing installations behave as before.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'

type Ex = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export type ProjectPriorities = { allowed: number[] | null; defaultId: number | null }

export async function projectPriorities(projectId: number, ex: Ex = db): Promise<ProjectPriorities> {
  const [assoc] = await ex.select({ schemeId: schema.prioritySchemeAssociations.schemeId, def: schema.prioritySchemes.defaultPriorityId })
    .from(schema.prioritySchemeAssociations)
    .innerJoin(schema.prioritySchemes, eq(schema.prioritySchemes.id, schema.prioritySchemeAssociations.schemeId))
    .where(eq(schema.prioritySchemeAssociations.projectId, projectId)).limit(1)
  if (!assoc) return { allowed: null, defaultId: null }
  const items = await ex.select({ id: schema.prioritySchemeItems.priorityId }).from(schema.prioritySchemeItems)
    .where(eq(schema.prioritySchemeItems.schemeId, assoc.schemeId))
  return { allowed: items.map((i) => i.id), defaultId: assoc.def }
}

/** Throws when the project's scheme does not offer this priority. Clearing a priority (null) is always allowed. */
export async function assertPriorityAllowed(projectId: number, priorityId: number | null | undefined, ex: Ex = db): Promise<void> {
  if (priorityId == null) return
  const { allowed } = await projectPriorities(projectId, ex)
  if (allowed && !allowed.includes(priorityId)) throw new Error('Priority is not available in this project\'s priority scheme')
}

/** Priority for a new issue: the one asked for (validated), else the scheme default, else none. */
export async function priorityForNewIssue(projectId: number, requested: number | null | undefined, ex: Ex = db): Promise<number | undefined> {
  if (requested != null) { await assertPriorityAllowed(projectId, requested, ex); return requested }
  return (await projectPriorities(projectId, ex)).defaultId ?? undefined
}

