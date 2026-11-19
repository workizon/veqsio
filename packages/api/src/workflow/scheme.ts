import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, or, isNull } from 'drizzle-orm';

export async function getWorkflowForIssueType(projectId: number, issueTypeId: number) {
  const assoc = await db
    .select()
    .from(schema.workflowSchemeAssociations)
    .where(eq(schema.workflowSchemeAssociations.projectId, projectId))
    .limit(1);

  if (assoc.length === 0) {
    // Return default workflow
    return db.select().from(schema.workflows).where(eq(schema.workflows.isDefault, true)).limit(1);
  }

  const schemeId = assoc[0].schemeId;

  // Check explicit mapping
  const item = await db
    .select()
    .from(schema.workflowSchemeItems)
    .where(and(
      eq(schema.workflowSchemeItems.schemeId, schemeId),
      eq(schema.workflowSchemeItems.issueTypeId, issueTypeId)
    ))
    .limit(1);

  if (item.length > 0) {
    return db.select().from(schema.workflows).where(eq(schema.workflows.id, item[0].workflowId)).limit(1);
  }

  // Return default workflow
  return db.select().from(schema.workflows).where(eq(schema.workflows.isDefault, true)).limit(1);
}

export async function getTransitions(workflowId: number, fromStatusId: number | null) {
  const transitions = await db
    .select()
    .from(schema.workflowTransitions)
    .where(and(
      eq(schema.workflowTransitions.workflowId, workflowId),
      fromStatusId !== null
        ? or(eq(schema.workflowTransitions.fromStatusId, fromStatusId), isNull(schema.workflowTransitions.fromStatusId))
        : isNull(schema.workflowTransitions.fromStatusId)
    ));
  // A global transition (from = any) is offered from every status except its own target.
  return transitions.filter((t) => t.fromStatusId !== null || t.toStatusId !== fromStatusId);
}
