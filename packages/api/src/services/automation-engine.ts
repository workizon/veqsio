import { db } from '../db';
import { outboundFetch } from '../security/outbound';
import * as schema from '@veqsio/db';
import { eq, and, sql } from 'drizzle-orm';
import { parseJQLSafe } from '../jql';
import { doTransition } from '../workflow/engine';
import { createIssue, updateIssue, getIssue, buildIssueResponse } from '../issues/service';
import type { JQLContext } from '../jql';
import type { IssueResponse } from '../issues/types';
import { handleIssueEvent } from '../agents/dispatch';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type TriggerEvent =
  | 'issue_created'
  | 'issue_updated'
  | 'issue_commented'
  | 'issue_transitioned'
  | 'sprint_started'
  | 'manual'
  | 'scheduled';

interface EventPayload {
  event: TriggerEvent;
  issueId: number;
  issueKey: string;
  projectId: number;
  userId: number;
  changes?: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
  commentId?: number;
  transitionId?: number;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export async function emitIssueCreated(issueId: number, userId: number) {
  const issue = await getIssue(issueId);
  if (!issue) return;
  await runAutomation({
    event: 'issue_created',
    issueId,
    issueKey: issue.key,
    projectId: issue.fields.project.id,
    userId,
  });
}

export async function emitIssueUpdated(
  issueId: number,
  userId: number,
  changes: Array<{ field: string; oldValue: string | null; newValue: string | null }>
) {
  const issue = await getIssue(issueId);
  if (!issue) return;
  await runAutomation({
    event: 'issue_updated',
    issueId,
    issueKey: issue.key,
    projectId: issue.fields.project.id,
    userId,
    changes,
  });
}

export async function emitIssueCommented(issueId: number, userId: number, commentId: number) {
  const issue = await getIssue(issueId);
  if (!issue) return;
  await runAutomation({
    event: 'issue_commented',
    issueId,
    issueKey: issue.key,
    projectId: issue.fields.project.id,
    userId,
    commentId,
  });
}

export async function emitIssueTransitioned(issueId: number, userId: number, transitionId: number) {
  const issue = await getIssue(issueId);
  if (!issue) return;
  await runAutomation({
    event: 'issue_transitioned',
    issueId,
    issueKey: issue.key,
    projectId: issue.fields.project.id,
    userId,
    transitionId,
  });
}

export async function executeRuleManually(
  rule: typeof schema.automationRules.$inferSelect,
  context: { issueId: number; issueKey: string; projectId: number; userId: number }
) {
  await executeRule(rule, {
    event: 'manual',
    issueId: context.issueId,
    issueKey: context.issueKey,
    projectId: context.projectId,
    userId: context.userId,
  });
}

/* ------------------------------------------------------------------ */
/*  Core Engine                                                        */
/* ------------------------------------------------------------------ */

async function runAutomation(payload: EventPayload) {
  // AI agents: assignment, mentions, status changes and comments start agent runs (never throws, never blocks).
  if (payload.event === 'issue_created' || payload.event === 'issue_updated' || payload.event === 'issue_commented' || payload.event === 'issue_transitioned') {
    await handleIssueEvent({ event: payload.event, issueId: payload.issueId, projectId: payload.projectId, userId: payload.userId, changes: payload.changes, commentId: payload.commentId });
  }
  const rules = await findMatchingRules(payload);
  for (const rule of rules) {
    await executeRule(rule, payload);
  }
}

async function findMatchingRules(payload: EventPayload) {
  const allRules = await db
    .select()
    .from(schema.automationRules)
    .where(eq(schema.automationRules.isEnabled, true));

  const matched: (typeof allRules)[number][] = [];
  for (const rule of allRules) {
    if (rule.projectId !== null && rule.projectId !== payload.projectId) continue;

    const triggers = await db
      .select()
      .from(schema.automationTriggers)
      .where(eq(schema.automationTriggers.ruleId, rule.id));

    const hasTrigger = triggers.some((t) => t.triggerType === payload.event);
    if (hasTrigger) matched.push(rule);
  }
  return matched;
}

async function executeRule(
  rule: typeof schema.automationRules.$inferSelect,
  payload: EventPayload
) {
  const execution = await db
    .insert(schema.automationExecutions)
    .values({
      ruleId: rule.id,
      triggeredBy: payload.event,
      triggerIssueKey: payload.issueKey,
      status: 'running',
    })
    .returning();

  const executionId = execution[0].id;

  try {
    // Fetch conditions and actions
    const conditions = await db
      .select()
      .from(schema.automationConditions)
      .where(eq(schema.automationConditions.ruleId, rule.id))
      .orderBy(schema.automationConditions.position);

    const actions = await db
      .select()
      .from(schema.automationActions)
      .where(eq(schema.automationActions.ruleId, rule.id))
      .orderBy(schema.automationActions.position);

    // Evaluate conditions
    const passes = await evaluateConditions(conditions, payload, rule);
    if (!passes) {
      await db
        .update(schema.automationExecutions)
        .set({ status: 'skipped', completedAt: new Date() })
        .where(eq(schema.automationExecutions.id, executionId));
      return;
    }

    // Execute actions
    const results: any[] = [];
    for (const action of actions) {
      const res = await executeAction(action, payload, rule);
      results.push({ actionId: action.id, actionType: action.actionType, result: res });
    }

    await db
      .update(schema.automationExecutions)
      .set({
        status: 'success',
        completedAt: new Date(),
        result: JSON.stringify({ actions: results }),
      })
      .where(eq(schema.automationExecutions.id, executionId));
  } catch (err: any) {
    await db
      .update(schema.automationExecutions)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage: err.message || String(err),
      })
      .where(eq(schema.automationExecutions.id, executionId));
    console.error(`[Automation] Rule ${rule.id} failed:`, err);
  }
}

/* ------------------------------------------------------------------ */
/*  Condition Evaluator                                                */
/* ------------------------------------------------------------------ */

async function evaluateConditions(
  conditions: (typeof schema.automationConditions.$inferSelect)[],
  payload: EventPayload,
  rule: typeof schema.automationRules.$inferSelect
): Promise<boolean> {
  if (conditions.length === 0) return true;

  const issue = await db
    .select()
    .from(schema.issues)
    .where(eq(schema.issues.id, payload.issueId))
    .limit(1);
  if (issue.length === 0) return false;
  const issueRow = issue[0];

  let result = await evaluateSingleCondition(conditions[0], issueRow, payload, rule);
  for (let i = 1; i < conditions.length; i++) {
    const cond = conditions[i];
    const val = await evaluateSingleCondition(cond, issueRow, payload, rule);
    if (cond.operator === 'OR') {
      result = result || val;
    } else {
      result = result && val;
    }
  }
  return result;
}

async function evaluateSingleCondition(
  cond: typeof schema.automationConditions.$inferSelect,
  issueRow: typeof schema.issues.$inferSelect,
  payload: EventPayload,
  rule: typeof schema.automationRules.$inferSelect
): Promise<boolean> {
  const config = (cond.config || {}) as Record<string, any>;

  switch (cond.conditionType) {
    case 'jql_match': {
      const jql = config.jql as string;
      if (!jql) return true;
      const ctx = await buildJQLContext(rule.projectId ?? issueRow.projectId, payload.userId);
      const parsed = parseJQLSafe(jql, ctx);
      if (!parsed.success) {
        console.error('[Automation] Invalid JQL in condition:', parsed.error);
        return false;
      }
      const jqlWhere = parsed.result.where;
      const finalWhere = jqlWhere ? and(jqlWhere, eq(schema.issues.id, payload.issueId)) : eq(schema.issues.id, payload.issueId);
      const rows = await db.select({ id: schema.issues.id }).from(schema.issues).where(finalWhere!).limit(1);
      return rows.length > 0;
    }

    case 'field_equals': {
      const field = config.field as string;
      const value = config.value;
      return compareField(issueRow, field, value, 'eq');
    }

    case 'field_changed': {
      const field = config.field as string;
      if (!payload.changes) return false;
      return payload.changes.some((c) => c.field === field);
    }

    case 'issue_type_is': {
      return issueRow.issueTypeId === Number(config.issueTypeId);
    }

    case 'priority_is': {
      return issueRow.priorityId === (config.priorityId ? Number(config.priorityId) : null);
    }

    case 'status_is': {
      return issueRow.statusId === Number(config.statusId);
    }

    case 'assignee_is': {
      return issueRow.assigneeId === (config.assigneeId ? Number(config.assigneeId) : null);
    }

    case 'reporter_is_current_user': {
      return issueRow.reporterId === payload.userId;
    }

    case 'issue_is_subtask': {
      return issueRow.parentId !== null;
    }

    default:
      return true;
  }
}

function compareField(
  issueRow: typeof schema.issues.$inferSelect,
  field: string,
  value: any,
  op: 'eq' | 'ne' | 'gt' | 'lt'
): boolean {
  const actual = resolveIssueField(issueRow, field);
  const expected = value === undefined ? null : value;
  if (op === 'eq') {
    if (actual === null && expected === null) return true;
    return String(actual) === String(expected);
  }
  return false;
}

function resolveIssueField(issueRow: typeof schema.issues.$inferSelect, field: string): any {
  switch (field) {
    case 'summary': return issueRow.summary;
    case 'description': return issueRow.description;
    case 'status': return issueRow.statusId;
    case 'priority': return issueRow.priorityId;
    case 'assignee': return issueRow.assigneeId;
    case 'reporter': return issueRow.reporterId;
    case 'project': return issueRow.projectId;
    case 'issuetype': return issueRow.issueTypeId;
    case 'key': return issueRow.issueKey;
    case 'resolution': return issueRow.resolutionId;
    default: return null;
  }
}

async function buildJQLContext(projectId?: number, currentUserId?: number): Promise<JQLContext> {
  const statuses = await db.select().from(schema.statuses);
  const priorities = await db.select().from(schema.priorities);
  const issueTypes = await db.select().from(schema.issueTypes);
  const projects = await db.select().from(schema.projects);
  const users = await db.select().from(schema.users);

  return {
    currentUserId,
    statusNames: Object.fromEntries(statuses.map((s) => [s.name.toLowerCase(), s.id])),
    priorityNames: Object.fromEntries(priorities.map((p) => [p.name.toLowerCase(), p.id])),
    issueTypeNames: Object.fromEntries(issueTypes.map((t) => [t.name.toLowerCase(), t.id])),
    projectKeys: Object.fromEntries(projects.map((p) => [p.projectKey.toLowerCase(), p.id])),
    projectNames: Object.fromEntries(projects.map((p) => [p.name.toLowerCase(), p.id])),
    userNames: Object.fromEntries(users.map((u) => [u.displayName.toLowerCase(), u.id])),
  };
}

/* ------------------------------------------------------------------ */
/*  Action Executor                                                    */
/* ------------------------------------------------------------------ */

async function executeAction(
  action: typeof schema.automationActions.$inferSelect,
  payload: EventPayload,
  rule: typeof schema.automationRules.$inferSelect
): Promise<any> {
  const config = (action.config || {}) as Record<string, any>;
  const actorId = rule.createdBy;

  switch (action.actionType) {
    case 'transition_issue': {
      const transitionId = Number(config.transitionId);
      if (!transitionId) throw new Error('transitionId required');
      await doTransition(payload.issueId, transitionId, actorId, {});
      return { transitioned: true };
    }

    case 'assign_issue': {
      const assigneeId = config.assigneeId ? Number(config.assigneeId) : null;
      await updateIssue(payload.issueId, { assigneeId }, actorId);
      return { assigneeId };
    }

    case 'add_comment': {
      const body = String(config.body || '');
      if (!body) throw new Error('Comment body required');
      const [comment] = await db.insert(schema.comments).values({
        issueId: payload.issueId,
        body,
        authorId: actorId,
      }).returning();
      return { commentId: comment.id };
    }

    case 'update_field': {
      const field = config.field as string;
      const value = config.value;
      const updateData: any = {};
      if (field === 'summary') updateData.summary = value;
      else if (field === 'description') updateData.description = value;
      else if (field === 'priority') updateData.priorityId = value ? Number(value) : null;
      else if (field === 'assignee') updateData.assigneeId = value ? Number(value) : null;
      else if (field === 'status') updateData.statusId = value ? Number(value) : null;
      else if (field === 'resolution') updateData.resolutionId = value ? Number(value) : null;
      else if (field === 'duedate') updateData.dueDate = value ? new Date(value) : null;
      else if (field === 'environment') updateData.environment = value;
      else if (field === 'timeestimate') updateData.timeEstimate = value ? Number(value) : null;
      else if (field === 'timespent') updateData.timeSpent = value ? Number(value) : null;
      else throw new Error(`Unsupported field: ${field}`);
      await updateIssue(payload.issueId, updateData, actorId);
      return { field, value };
    }

    case 'create_issue': {
      const projectId = Number(config.projectId || payload.projectId);
      const issueTypeId = Number(config.issueTypeId);
      const summary = String(config.summary || 'Automated issue');
      const description = config.description ? String(config.description) : undefined;
      const priorityId = config.priorityId ? Number(config.priorityId) : undefined;
      const assigneeId = config.assigneeId ? Number(config.assigneeId) : undefined;
      const parentId = config.parentId ? Number(config.parentId) : undefined;
      const newIssue = await createIssue({ projectId, issueTypeId, summary, description, priorityId, assigneeId, parentId }, actorId);
      return { issueKey: newIssue.key, issueId: newIssue.id };
    }

    case 'add_label': {
      const labelName = String(config.label || '');
      if (!labelName) throw new Error('Label name required');
      let label = await db.select().from(schema.labels).where(eq(schema.labels.name, labelName)).limit(1);
      let labelId: number;
      if (label.length === 0) {
        const [newLabel] = await db.insert(schema.labels).values({ name: labelName }).returning();
        labelId = newLabel.id;
      } else {
        labelId = label[0].id;
      }
      await db.insert(schema.issueLabels).values({ issueId: payload.issueId, labelId }).onConflictDoNothing();
      return { labelId };
    }

    case 'remove_label': {
      const labelName = String(config.label || '');
      if (!labelName) throw new Error('Label name required');
      const label = await db.select().from(schema.labels).where(eq(schema.labels.name, labelName)).limit(1);
      if (label.length > 0) {
        await db.delete(schema.issueLabels).where(
          and(eq(schema.issueLabels.issueId, payload.issueId), eq(schema.issueLabels.labelId, label[0].id))
        );
      }
      return { removed: true };
    }

    case 'set_priority': {
      const priorityId = config.priorityId ? Number(config.priorityId) : null;
      await updateIssue(payload.issueId, { priorityId }, actorId);
      return { priorityId };
    }

    case 'link_issue': {
      const inwardId = Number(config.inwardIssueId || payload.issueId);
      const outwardId = Number(config.outwardIssueId);
      const linkTypeId = Number(config.linkTypeId);
      if (!outwardId || !linkTypeId) throw new Error('outwardIssueId and linkTypeId required');
      const { linkIssues } = await import('../issues/links');
      await linkIssues(inwardId, outwardId, linkTypeId, actorId);
      return { linked: true };
    }

    case 'send_webhook': {
      const url = String(config.url || '');
      if (!url) throw new Error('Webhook URL required');
      const issue = await getIssue(payload.issueId);
      const body = JSON.stringify({ event: payload.event, issue, rule: rule.name, timestamp: new Date().toISOString() });
      const res = await outboundFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
      return { status: res.status };
    }

    case 'send_email': {
      const toAddress = String(config.toAddress || '');
      const subject = String(config.subject || `Veqsio automation: ${rule.name}`);
      const htmlBody = String(config.body || '<p>Automation triggered.</p>');
      if (!toAddress) throw new Error('toAddress required');
      await db.insert(schema.emailQueue).values({
        toAddress,
        subject,
        htmlBody,
        textBody: htmlBody,
      });
      return { queued: true };
    }

    case 'log_action': {
      const message = String(config.message || 'Automation action logged');
      console.info(`[Automation Log] Rule ${rule.id}: ${message}`);
      return { message };
    }

    default:
      return { skipped: true, reason: 'Unsupported action type' };
  }
}
