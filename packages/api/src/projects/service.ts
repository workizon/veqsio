import { asc, eq, ilike, ne, and } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/

export interface NewProject { key: string; name: string; description?: string | null; leadId: number; category?: string | null }

/**
 * Create a project together with everything an issue-creating project needs, inside the caller's
 * transaction: the issue key counter, the default permission scheme association, the workflow /
 * issue type / field configuration schemes and the lead as Administrators role actor.
 *
 * "Default" schemes are those of the oldest existing project that has one (the instance default
 * created at installation); the permission scheme falls back to the lowest-id scheme. Missing
 * pieces are skipped, never invented, so this works on a bare database too.
 * Throws a unique violation (23505) when the key is taken.
 */
export async function createProjectWithDefaults(tx: Tx, p: NewProject): Promise<typeof schema.projects.$inferSelect> {
  const [project] = await tx.insert(schema.projects).values({
    projectKey: p.key, name: p.name, description: p.description ?? null, leadId: p.leadId, category: p.category ?? null,
  }).returning()
  await tx.insert(schema.projectIssueCounters).values({ projectId: project.id, currentValue: 0 }).onConflictDoNothing()

  // permission scheme
  const [permRef] = await tx.select({ schemeId: schema.permissionSchemeAssociations.schemeId }).from(schema.permissionSchemeAssociations)
    .where(ne(schema.permissionSchemeAssociations.projectId, project.id)).orderBy(asc(schema.permissionSchemeAssociations.projectId)).limit(1)
  let permSchemeId = permRef?.schemeId
  if (!permSchemeId) {
    const [s] = await tx.select({ id: schema.permissionSchemes.id }).from(schema.permissionSchemes).orderBy(asc(schema.permissionSchemes.id)).limit(1)
    permSchemeId = s?.id
  }
  if (permSchemeId) await tx.insert(schema.permissionSchemeAssociations).values({ projectId: project.id, schemeId: permSchemeId }).onConflictDoNothing()

  const [wf] = await tx.select({ schemeId: schema.workflowSchemeAssociations.schemeId }).from(schema.workflowSchemeAssociations)
    .where(ne(schema.workflowSchemeAssociations.projectId, project.id)).orderBy(asc(schema.workflowSchemeAssociations.projectId)).limit(1)
  if (wf) await tx.insert(schema.workflowSchemeAssociations).values({ projectId: project.id, schemeId: wf.schemeId }).onConflictDoNothing()

  const [it] = await tx.select({ schemeId: schema.issueTypeSchemeAssociations.schemeId }).from(schema.issueTypeSchemeAssociations)
    .where(ne(schema.issueTypeSchemeAssociations.projectId, project.id)).orderBy(asc(schema.issueTypeSchemeAssociations.projectId)).limit(1)
  if (it) await tx.insert(schema.issueTypeSchemeAssociations).values({ projectId: project.id, schemeId: it.schemeId }).onConflictDoNothing()

  const [refProject] = await tx.select({ projectId: schema.fieldConfigurationSchemeAssociations.projectId }).from(schema.fieldConfigurationSchemeAssociations)
    .where(ne(schema.fieldConfigurationSchemeAssociations.projectId, project.id)).orderBy(asc(schema.fieldConfigurationSchemeAssociations.projectId)).limit(1)
  if (refProject) {
    const rows = await tx.select().from(schema.fieldConfigurationSchemeAssociations)
      .where(eq(schema.fieldConfigurationSchemeAssociations.projectId, refProject.projectId))
    if (rows.length) {
      await tx.insert(schema.fieldConfigurationSchemeAssociations)
        .values(rows.map((r) => ({ projectId: project.id, issueTypeId: r.issueTypeId, configId: r.configId }))).onConflictDoNothing()
    }
  }

  const [adminRole] = await tx.select({ id: schema.projectRoles.id }).from(schema.projectRoles)
    .where(ilike(schema.projectRoles.name, 'Administrators')).limit(1)
  if (adminRole) {
    await tx.insert(schema.projectRoleActors).values({ projectId: project.id, roleId: adminRole.id, userId: p.leadId, groupId: null })
  }
  return project
}

/** Lets callers check the key shape without a DB round-trip (Jira style: upper-case letters/digits, 2-10 chars). */
export const isValidProjectKey = (k: string) => PROJECT_KEY_RE.test(k)

export async function projectKeyTaken(key: string): Promise<boolean> {
  const [r] = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.projectKey, key))).limit(1)
  return !!r
}
