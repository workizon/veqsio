import { db } from '../db';
import * as schema from '@veqsio/db';
import { and, eq } from 'drizzle-orm';
import type { PostFunction } from './types';

export interface PostFunctionContext {
  issueId: number;
  userId: number;
  projectId: number;
  transitionId: number;
  toStatusId: number;
  fields: Record<string, any>;
  /** Callbacks the engine runs after the surrounding transaction committed (emails, webhooks). */
  afterCommit?: Array<() => Promise<void>>;
}

export async function executePostFunctions(
  postFunctions: PostFunction[],
  context: PostFunctionContext,
  tx?: any
): Promise<void> {
  if (!postFunctions || postFunctions.length === 0) return;

  const executor = tx || db;

  for (const pf of postFunctions) {
    await executeSinglePostFunction(pf, context, executor);
  }
}

async function executeSinglePostFunction(
  pf: PostFunction,
  context: PostFunctionContext,
  executor: any
): Promise<void> {
  switch (pf.type) {
    case 'update_field':
      if (pf.field === 'status') {
        await executor.update(schema.issues)
          .set({ statusId: context.toStatusId })
          .where(eq(schema.issues.id, context.issueId));
      }
      break;

    case 'assign_to_user': {
      const assigneeId = pf.user_id === null ? context.userId : pf.user_id;
      await executor.update(schema.issues)
        .set({ assigneeId })
        .where(eq(schema.issues.id, context.issueId));
      break;
    }

    case 'set_resolution': {
      const resolutionId = pf.resolution_id;
      if (resolutionId !== undefined) {
        await executor.update(schema.issues)
          .set({ resolutionId, resolvedAt: new Date() })
          .where(eq(schema.issues.id, context.issueId));
      }
      break;
    }

    case 'clear_field':
      if (pf.field === 'resolution') {
        await executor.update(schema.issues)
          .set({ resolutionId: null, resolvedAt: null })
          .where(eq(schema.issues.id, context.issueId));
      }
      break;

    case 'add_comment':
      if (pf.body) {
        await executor.insert(schema.comments).values({
          issueId: context.issueId,
          body: pf.body,
          authorId: context.userId,
        });
      }
      break;

    case 'update_date':
      if (pf.field === 'resolved_at') {
        await executor.update(schema.issues)
          .set({ resolvedAt: new Date() })
          .where(eq(schema.issues.id, context.issueId));
      }
      break;

    case 'request_approval': {
      if (!pf.template) throw new Error('Request approval: no template configured');
      const [tpl] = await executor.select().from(schema.approvalTemplates)
        .where(and(eq(schema.approvalTemplates.projectId, context.projectId), eq(schema.approvalTemplates.name, pf.template))).limit(1);
      if (!tpl) throw new Error(`Approval template '${pf.template}' does not exist in this project`);
      const { createApproval } = await import('../approvals/service');
      const r = await createApproval(executor, { issueId: context.issueId, createdBy: context.userId, template: tpl, onDuplicate: 'skip' });
      if (context.afterCommit) context.afterCommit.push(...r.after);
      break;
    }

    case 'fire_event':
      // Events are logged for notification system
      console.log(`Event fired: ${pf.event_id} for issue ${context.issueId}`);
      break;

    default:
      break;
  }
}
