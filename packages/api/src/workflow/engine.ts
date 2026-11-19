import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import { evaluateConditions } from './conditions';
import { evaluateValidators } from './validators';
import { approvalRequiredSatisfied } from '../approvals/service';
import { executePostFunctions } from './post-functions';
import { runTransitionCheck } from '../modules/hooks';
import { getWorkflowForIssueType, getTransitions } from './scheme';
import { buildTransitionMeta, normalizeCategory, parseResolutionInput, TransitionValidationError } from './transition-meta';
import { removeResolutionLabelsIfResolved } from '../labels/service';
import { applyIssueUpdate, type IssueChange } from '../issues/service';
import { parseScreenInput, type ParsedScreenInput } from './screen-fields';
import { loadScreenFields, currentValuePresence, checkScreenRefs } from './screen';
import type { Condition, Validator, PostFunction } from './types';

export async function getAvailableTransitions(issueId: number, userId: number) {
  const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1))[0];
  if (!issue) throw new Error('Issue not found');

  const workflows = await getWorkflowForIssueType(issue.projectId, issue.issueTypeId);
  if (workflows.length === 0) return [];
  const workflowId = workflows[0].id;

  const transitions = await getTransitions(workflowId, issue.statusId);

  const available = [];
  for (const t of transitions) {
    const conditions = (t.conditions as Condition[]) || [];
    const passes = await evaluateConditions(conditions, issueId, userId, issue.projectId);
    if (passes) {
      const toStatus = (await db.select().from(schema.statuses).where(eq(schema.statuses.id, t.toStatusId)).limit(1))[0];
      available.push({
        id: t.id,
        name: t.name,
        to: { id: t.toStatusId, name: toStatus?.name, statusCategory: toStatus?.category },
        hasScreen: t.screenId !== null,
        screenId: t.screenId,
        meta: buildTransitionMeta(
          (t.validators as Validator[]) || [],
          (t.postFunctions as PostFunction[]) || [],
          toStatus?.category,
          t.screenId !== null,
        ),
      });
    }
  }

  return available;
}

export async function doTransition(
  issueId: number,
  transitionId: number,
  userId: number,
  fields: Record<string, any> = {},
  options: { comment?: string; skipApprovalValidator?: boolean; system?: boolean } = {}
) {
  const afterCommit: Array<() => Promise<void>> = [];
  const result = await db.transaction(async (tx) => {
    const issue = (await tx.select().from(schema.issues).where(eq(schema.issues.id, issueId)).for('update').limit(1))[0];
    if (!issue) throw new Error('Issue not found');

    const transition = (await tx.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.id, transitionId)).limit(1))[0];
    if (!transition) throw new Error('Transition not found');

    // Verify transition is valid from current status
    if (transition.fromStatusId !== null && transition.fromStatusId !== issue.statusId) {
      throw new Error('Invalid transition from current status');
    }

    // Evaluate conditions within transaction
    const conditions = (transition.conditions as Condition[]) || [];
    // System actors (approval auto-transitions) have no user to check conditions against.
    const passes = options.system ? true : await evaluateConditions(conditions, issueId, userId, issue.projectId, tx);
    if (!passes) throw new Error('You do not have permission to execute this transition');

    // Evaluate validators
    const validators = (transition.validators as Validator[]) || [];
    const validation = evaluateValidators(validators, { fields, issueId });
    const errors = [...validation.errors];
    // The approval validator is the ONLY validator a system-run transition may skip.
    if (!options.skipApprovalValidator) {
      for (const v of validators.filter((x) => x && x.type === 'approval_required')) {
        const r = await approvalRequiredSatisfied(tx, issueId, v.template || undefined);
        if (!r.ok) errors.push(r.message);
      }
    }
    // Named checks provided by modules (e.g. "postmortem required"); they run for system actors too.
    for (const v of validators.filter((x) => x && x.type === 'module_check' && typeof x.check === 'string')) {
      const toStatus = (await tx.select().from(schema.statuses).where(eq(schema.statuses.id, transition.toStatusId)).limit(1))[0];
      const msg = await runTransitionCheck(v.check!, {
        issueId, issueKey: issue.issueKey, projectId: issue.projectId, transitionId,
        fromStatusId: issue.statusId, toStatusId: transition.toStatusId, toStatusName: toStatus?.name ?? '', tx,
      });
      if (msg) errors.push(msg);
    }
    // Transition screen: validate the fields the screen asks for BEFORE anything is written, so a failure changes nothing.
    // System actors (approval auto-transitions) have nobody to ask and skip the screen.
    let screenParsed: ParsedScreenInput | null = null;
    let fieldErrors: Record<string, string> = {};
    if (transition.screenId !== null && !options.system) {
      const defs = await loadScreenFields(transition.screenId, tx);
      if (defs.length > 0) {
        const present = await currentValuePresence(tx, issueId, defs);
        screenParsed = parseScreenInput(defs, { ...fields, comment: fields.comment ?? options.comment }, present);
        fieldErrors = { ...screenParsed.errors, ...(await checkScreenRefs(tx, issue.projectId, screenParsed.refs)) };
      }
    }
    if (errors.length > 0 || Object.keys(fieldErrors).length > 0) {
      throw new TransitionValidationError([...errors, ...Object.values(fieldErrors)], fieldErrors);
    }
    const authorId = options.system ? null : userId;

    // Optional resolution supplied by the transition dialog ({id}, id or name)
    let resolutionId: number | null = null;
    const resolutionInput = parseResolutionInput(fields.resolution);
    if (resolutionInput) {
      const rows = resolutionInput.id !== undefined
        ? await tx.select().from(schema.resolutions).where(eq(schema.resolutions.id, resolutionInput.id)).limit(1)
        : await tx.select().from(schema.resolutions).where(eq(schema.resolutions.name, resolutionInput.name!)).limit(1);
      if (!rows[0]) throw new TransitionValidationError(['Resolution not found']);
      resolutionId = rows[0].id;
    }

    // Capture old status before update
    const oldStatus = (await tx.select().from(schema.statuses).where(eq(schema.statuses.id, issue.statusId)).limit(1))[0];
    const newStatus = (await tx.select().from(schema.statuses).where(eq(schema.statuses.id, transition.toStatusId)).limit(1))[0];

    // Update status
    await tx.update(schema.issues)
      .set({ statusId: transition.toStatusId, updatedAt: new Date() })
      .where(eq(schema.issues.id, issueId));

    // Record history
    await tx.insert(schema.issueHistory).values({
      issueId,
      fieldName: 'status',
      oldValue: oldStatus?.name || null,
      newValue: newStatus?.name || null,
      authorId,
    });

    if (resolutionId !== null && normalizeCategory(newStatus?.category) === 'done') {
      const prev = issue.resolutionId
        ? (await tx.select().from(schema.resolutions).where(eq(schema.resolutions.id, issue.resolutionId)).limit(1))[0]
        : undefined;
      const next = (await tx.select().from(schema.resolutions).where(eq(schema.resolutions.id, resolutionId)).limit(1))[0];
      await tx.update(schema.issues).set({ resolutionId, resolvedAt: new Date() }).where(eq(schema.issues.id, issueId));
      await tx.insert(schema.issueHistory).values({
        issueId,
        fieldName: 'resolution',
        oldValue: prev?.name || null,
        newValue: next?.name || null,
        authorId,
      });
    }

    const commentBody = (options.comment ?? (typeof fields.comment === 'string' ? fields.comment : '')).trim();
    if (commentBody) {
      await tx.insert(schema.comments).values({ issueId, body: commentBody, authorId });
    }

    // Screen fields go through the normal issue edit code (history rows, label rules) in this same transaction.
    let screenChanges: IssueChange[] = [];
    if (screenParsed && Object.keys(screenParsed.update).length > 0) {
      screenChanges = (await applyIssueUpdate(tx, issueId, screenParsed.update, userId)).changes;
      if (screenChanges.length > 0) {
        afterCommit.push(async () => {
          const { emitIssueUpdated } = await import('../services/automation-engine');
          await emitIssueUpdated(issueId, userId, screenChanges);
        });
      }
    }

    // Execute post-functions within transaction
    const postFunctions = (transition.postFunctions as PostFunction[]) || [];
    await executePostFunctions(postFunctions, {
      issueId,
      userId,
      projectId: issue.projectId,
      transitionId,
      toStatusId: transition.toStatusId,
      fields,
      afterCommit,
    }, tx);

    // Entering a done-category status detaches labels flagged 'remove on resolution' (recorded in history).
    await removeResolutionLabelsIfResolved(issueId, userId, tx, { viaResolution: resolutionId !== null });

    return { success: true, changes: screenChanges };
  });
  for (const fn of afterCommit) {
    try { await fn(); } catch (e) { console.error('[workflow] after-commit hook failed', e); }
  }
  return result;
}
