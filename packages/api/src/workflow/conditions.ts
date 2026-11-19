import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, or } from 'drizzle-orm';
import type { Condition } from './types';

export async function evaluateConditions(
  conditions: Condition[],
  issueId: number,
  userId: number,
  projectId: number,
  tx?: any
): Promise<boolean> {
  if (!conditions || conditions.length === 0) return true;

  const executor = tx || db;

  for (const condition of conditions) {
    const result = await evaluateSingleCondition(condition, issueId, userId, projectId, executor);
    if (!result) return false;
  }
  return true;
}

async function evaluateSingleCondition(
  condition: Condition,
  issueId: number,
  userId: number,
  projectId: number,
  executor: any
): Promise<boolean> {
  switch (condition.type) {
    case 'always_true':
      return true;

    case 'user_in_project_role': {
      if (!condition.role_id) return false;
      const roleActors = await executor
        .select()
        .from(schema.projectRoleActors)
        .where(and(
          eq(schema.projectRoleActors.projectId, projectId),
          eq(schema.projectRoleActors.roleId, condition.role_id),
          eq(schema.projectRoleActors.userId, userId)
        ))
        .limit(1);
      if (roleActors.length > 0) return true;
      // Check group membership in role
      const groupActors = await executor
        .select()
        .from(schema.projectRoleActors)
        .where(and(
          eq(schema.projectRoleActors.projectId, projectId),
          eq(schema.projectRoleActors.roleId, condition.role_id)
        ));
      for (const actor of groupActors) {
        if (actor.groupId) {
          const inGroup = await executor
            .select()
            .from(schema.userGroups)
            .where(and(
              eq(schema.userGroups.userId, userId),
              eq(schema.userGroups.groupId, actor.groupId)
            ))
            .limit(1);
          if (inGroup.length > 0) return true;
        }
      }
      return false;
    }

    case 'user_in_group': {
      if (!condition.group_id) return false;
      const inGroup = await executor
        .select()
        .from(schema.userGroups)
        .where(and(
          eq(schema.userGroups.userId, userId),
          eq(schema.userGroups.groupId, condition.group_id)
        ))
        .limit(1);
      return inGroup.length > 0;
    }

    case 'issue_field_value': {
      // Simplified: only check assignee presence
      if (condition.field === 'assignee' && condition.operator === 'is_not_empty') {
        const issue = await executor.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1);
        return issue.length > 0 && issue[0].assigneeId !== null;
      }
      return true;
    }

    case 'permission_check': {
      // Delegate to RBAC service
      const { hasProjectPermission } = await import('../rbac/service');
      if (!condition.permission) return false;
      return hasProjectPermission(userId, projectId, condition.permission as any);
    }

    default:
      return true;
  }
}
