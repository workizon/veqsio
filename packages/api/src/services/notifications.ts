import type { IssueResponse } from '../issues/types';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, inArray } from 'drizzle-orm';
import { sendEmail, queueEmails } from './email';
import { usersWhoCanSee } from '../security/issue-security';
import { sendPush, mentionedUsernames } from './push';
import { deliverWebhook } from './webhooks';
import type { WebhookEvent } from './webhooks';

export type RecipientRule = 'assignee' | 'reporter' | 'watcher' | 'project-lead'

export interface RecipientOptions {
  includeAssignee?: boolean;
  includeReporter?: boolean;
  includeWatchers?: boolean;
  includeProjectLead?: boolean;
  excludeUserId?: number;
  /** Extra users to leave out (e.g. service desk customers, who get their own reply mail). */
  excludeUserIds?: number[];
}

/**
 * Who gets an e-mail for which issue event. This table is what the senders below use, and what the admin
 * notification helper explains. `excludeActor` = the person who caused the event is not notified about it.
 */
export type IssueEvent = 'issue.created' | 'issue.updated' | 'issue.transitioned' | 'comment.added' | 'issue.assigned'
export const ISSUE_EVENT_RULES: Record<IssueEvent, { label: string; rules: RecipientRule[]; excludeActor: boolean }> = {
  'issue.created': { label: 'Issue created', rules: ['assignee', 'reporter', 'watcher', 'project-lead'], excludeActor: false },
  'issue.updated': { label: 'Issue updated', rules: ['assignee', 'reporter', 'watcher', 'project-lead'], excludeActor: true },
  'issue.transitioned': { label: 'Issue transitioned (status change)', rules: ['assignee', 'reporter', 'watcher', 'project-lead'], excludeActor: true },
  'comment.added': { label: 'Comment added', rules: ['assignee', 'reporter', 'watcher', 'project-lead'], excludeActor: true },
  'issue.assigned': { label: 'Issue assigned', rules: ['assignee'], excludeActor: false },
};

export function recipientOptionsFor(event: IssueEvent, actorId?: number | null, excludeUserIds?: number[]): RecipientOptions {
  const r = ISSUE_EVENT_RULES[event];
  return {
    includeAssignee: r.rules.includes('assignee'),
    includeReporter: r.rules.includes('reporter'),
    includeWatchers: r.rules.includes('watcher'),
    includeProjectLead: r.rules.includes('project-lead'),
    excludeUserId: r.excludeActor && actorId ? actorId : undefined,
    excludeUserIds,
  };
}

/** Rule matching without touching users: which user ids qualify through which rule, and who was dropped as the actor. */
export async function resolveIssueRecipients(issueId: number, options: RecipientOptions): Promise<{ matches: Map<number, RecipientRule[]>; excluded: Set<number>; hidden: Set<number> }> {
  const matches = new Map<number, RecipientRule[]>();
  const add = (id: number, rule: RecipientRule) => matches.set(id, [...(matches.get(id) ?? []), rule]);
  const issue = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1);
  if (issue.length === 0) return { matches, excluded: new Set(), hidden: new Set() };

  if (options.includeAssignee && issue[0].assigneeId) add(issue[0].assigneeId, 'assignee');
  if (options.includeReporter && issue[0].reporterId) add(issue[0].reporterId, 'reporter');

  if (options.includeWatchers) {
    const watchers = await db.select({ userId: schema.watchers.userId }).from(schema.watchers).where(eq(schema.watchers.issueId, issueId));
    for (const w of watchers) add(w.userId, 'watcher');
  }

  if (options.includeProjectLead) {
    const project = await db.select().from(schema.projects).where(eq(schema.projects.id, issue[0].projectId)).limit(1);
    if (project.length > 0 && project[0].leadId) add(project[0].leadId, 'project-lead');
  }

  const excluded = new Set<number>();
  if (options.excludeUserId && matches.delete(options.excludeUserId)) excluded.add(options.excludeUserId);
  for (const id of options.excludeUserIds ?? []) if (matches.delete(id)) excluded.add(id);
  // Issue security: never mail someone who cannot see the issue (applies to every mail built on these recipients).
  const hidden = new Set<number>();
  if (matches.size > 0 && issue[0].securityLevelId !== null) {
    const can = await usersWhoCanSee(issueId, [...matches.keys()]);
    for (const id of [...matches.keys()]) if (!can.has(id)) { matches.delete(id); hidden.add(id); }
  }
  return { matches, excluded, hidden };
}

async function getRecipients(issueId: number, options: RecipientOptions): Promise<typeof schema.users.$inferSelect[]> {
  const { matches } = await resolveIssueRecipients(issueId, options);
  if (matches.size === 0) return [];
  return db.select().from(schema.users).where(inArray(schema.users.id, Array.from(matches.keys())));
}

/**
 * The REST routes pass the API response shape ({ key, fields: { project, summary, ... } }) while the senders
 * below read database columns (issueKey, projectId, ...). With the response shape `issue.projectId` was undefined,
 * every query threw "Undefined values are not allowed" and no create/update/comment notification was ever sent.
 * Accept both shapes.
 */
/** The REST routes pass the API response shape, other callers a database row; asIssueRow turns either into a row. */
export type NotifiableIssue = typeof schema.issues.$inferSelect | IssueResponse;

function asIssueRow(issue: any): typeof schema.issues.$inferSelect {
  if (issue && issue.projectId !== undefined) return issue;
  const f = issue?.fields ?? {};
  return {
    ...issue,
    issueKey: issue.key,
    projectId: f.project?.id,
    summary: f.summary,
    priorityId: f.priority?.id ?? null,
    assigneeId: f.assignee?.id ?? null,
    reporterId: f.reporter?.id ?? null,
  } as typeof schema.issues.$inferSelect;
}

function buildBaseUrl(): string {
  return process.env.WEB_URL || 'http://localhost:3001';
}

export async function notifyIssueCreated(
  issue: NotifiableIssue,
  recipients?: number[]
): Promise<void> {
  issue = asIssueRow(issue);
  const users = recipients
    ? await db.select().from(schema.users).where(inArray(schema.users.id, recipients))
    : await getRecipients(issue.id, recipientOptionsFor('issue.created'));

  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, issue.projectId)).limit(1);
  const reporter = issue.reporterId
    ? await db.select().from(schema.users).where(eq(schema.users.id, issue.reporterId)).limit(1)
    : [];
  const assignee = issue.assigneeId
    ? await db.select().from(schema.users).where(eq(schema.users.id, issue.assigneeId)).limit(1)
    : [];
  const priority = issue.priorityId
    ? await db.select().from(schema.priorities).where(eq(schema.priorities.id, issue.priorityId)).limit(1)
    : [];

  const baseUrl = buildBaseUrl();
  const data = {
    issueKey: issue.issueKey,
    summary: issue.summary,
    projectName: project[0]?.name || 'Unknown',
    reporterName: reporter[0]?.displayName || 'Unknown',
    priority: priority[0]?.name,
    assignee: assignee[0]?.displayName,
    issueUrl: `${baseUrl}/issues/${issue.issueKey}`,
  };

  await queueEmails(users.map((u) => u.email), 'issue-created', data);
  await deliverWebhook('issue.created', { ...data, projectId: issue.projectId, issueId: issue.id });
}

export async function notifyIssueUpdated(
  issue: NotifiableIssue,
  changeLog: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
  authorId: number,
  recipients?: number[],
  excludeUserIds?: number[]
): Promise<void> {
  issue = asIssueRow(issue);
  const users = recipients
    ? await db.select().from(schema.users).where(inArray(schema.users.id, recipients))
    : await getRecipients(issue.id, recipientOptionsFor('issue.updated', authorId, excludeUserIds));

  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, issue.projectId)).limit(1);
  const author = await db.select().from(schema.users).where(eq(schema.users.id, authorId)).limit(1);

  const baseUrl = buildBaseUrl();
  const data = {
    issueKey: issue.issueKey,
    summary: issue.summary,
    projectName: project[0]?.name || 'Unknown',
    authorName: author[0]?.displayName || 'Unknown',
    changes: changeLog,
    issueUrl: `${baseUrl}/issues/${issue.issueKey}`,
  };

  await queueEmails(users.map((u) => u.email), 'issue-updated', data);

  const hasStatusChange = changeLog.some((c) => c.field === 'status');
  const event: WebhookEvent = hasStatusChange ? 'issue.transitioned' : 'issue.updated';
  await deliverWebhook(event, { ...data, projectId: issue.projectId, issueId: issue.id });
}

export async function notifyCommentAdded(
  comment: typeof schema.comments.$inferSelect,
  issue: NotifiableIssue,
  recipients?: number[],
  excludeUserIds?: number[]
): Promise<void> {
  issue = asIssueRow(issue);
  const users = recipients
    ? await db.select().from(schema.users).where(inArray(schema.users.id, recipients))
    : await getRecipients(issue.id, recipientOptionsFor('comment.added', comment.authorId, excludeUserIds));

  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, issue.projectId)).limit(1);
  const author = comment.authorId
    ? await db.select().from(schema.users).where(eq(schema.users.id, comment.authorId)).limit(1)
    : [];

  const baseUrl = buildBaseUrl();
  const data = {
    issueKey: issue.issueKey,
    summary: issue.summary,
    projectName: project[0]?.name || 'Unknown',
    authorName: author[0]?.displayName || 'Unknown',
    commentBody: comment.body,
    issueUrl: `${baseUrl}/issues/${issue.issueKey}?comment=${comment.id}`,
  };

  await queueEmails(users.map((u) => u.email), 'comment-added', data);

  // Browser push: people involved in the issue, plus anyone @mentioned who can see it. Explicit recipient lists
  // (internal notes) get no mention push, so a note can never reach someone it was not addressed to.
  try {
    const authorId = comment.authorId;
    const plain = users.filter((u) => u.id !== authorId).map((u) => u.id);
    let mentioned: number[] = [];
    const names = recipients ? [] : mentionedUsernames(comment.body || '');
    if (names.length) {
      const rows = await db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(eq(schema.users.active, true));
      const ids = rows.filter((r) => names.includes(r.username.toLowerCase()) && r.id !== authorId).map((r) => r.id);
      if (ids.length) { const seen = await usersWhoCanSee(issue.id, ids); mentioned = ids.filter((i) => seen.has(i)); }
    }
    const url = `/issues/${issue.issueKey}?comment=${comment.id}`;
    const who = author[0]?.displayName || 'Someone';
    await sendPush(mentioned, { title: `${who} mentioned you in ${issue.issueKey}`, body: comment.body || issue.summary, url, tag: `mention-${comment.id}`, kind: 'mention' });
    await sendPush(plain.filter((i) => !mentioned.includes(i)), { title: `${who} commented on ${issue.issueKey}`, body: comment.body || issue.summary, url, tag: `comment-${comment.id}`, kind: 'comment' });
  } catch (e) { console.error('[push] comment push failed:', e instanceof Error ? e.message : 'error'); }
  await deliverWebhook('comment.added', { ...data, projectId: issue.projectId, issueId: issue.id, commentId: comment.id });
}

export async function notifyIssueAssigned(
  issue: NotifiableIssue,
  assigneeId: number,
  assignerId: number
): Promise<void> {
  issue = asIssueRow(issue);
  const assignee = await db.select().from(schema.users).where(eq(schema.users.id, assigneeId)).limit(1);
  if (assignee.length === 0) return;

  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, issue.projectId)).limit(1);
  const assigner = await db.select().from(schema.users).where(eq(schema.users.id, assignerId)).limit(1);
  const priority = issue.priorityId
    ? await db.select().from(schema.priorities).where(eq(schema.priorities.id, issue.priorityId)).limit(1)
    : [];

  const baseUrl = buildBaseUrl();
  const data = {
    issueKey: issue.issueKey,
    summary: issue.summary,
    projectName: project[0]?.name || 'Unknown',
    assignerName: assigner[0]?.displayName || 'Unknown',
    priority: priority[0]?.name,
    issueUrl: `${baseUrl}/issues/${issue.issueKey}`,
  };

  if (issue.id && !(await usersWhoCanSee(issue.id, [assigneeId])).has(assigneeId)) return; // cannot see the issue (security level): no mail
  await sendEmail(assignee[0].email, 'issue-assigned', data);
  if (assigneeId !== assignerId) await sendPush([assigneeId], { title: `${data.assignerName} assigned ${issue.issueKey} to you`, body: issue.summary, url: `/issues/${issue.issueKey}`, tag: `assigned-${issue.issueKey}`, kind: 'assignment' });
  await deliverWebhook('issue.updated', { ...data, projectId: issue.projectId, issueId: issue.id, assignedTo: assigneeId });
}

export async function notifySprintEvent(
  sprint: typeof schema.sprints.$inferSelect,
  eventType: 'started' | 'closed',
  recipients?: number[]
): Promise<void> {
  const board = await db.select().from(schema.boards).where(eq(schema.boards.id, sprint.boardId)).limit(1);
  const project = board[0]
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, board[0].projectId)).limit(1)
    : [];

  let users: typeof schema.users.$inferSelect[] = [];
  if (recipients) {
    users = await db.select().from(schema.users).where(inArray(schema.users.id, recipients));
  } else if (project[0]?.leadId) {
    users = await db.select().from(schema.users).where(eq(schema.users.id, project[0].leadId));
  }

  const baseUrl = buildBaseUrl();

  if (eventType === 'started') {
    const data = {
      sprintName: sprint.name,
      goal: sprint.goal || undefined,
      boardName: board[0]?.name || 'Unknown',
      startDate: sprint.startDate ? new Date(sprint.startDate).toLocaleDateString() : undefined,
      endDate: sprint.endDate ? new Date(sprint.endDate).toLocaleDateString() : undefined,
      sprintUrl: `${baseUrl}/boards/${sprint.boardId}`,
    };
    await queueEmails(users.map((u) => u.email), 'sprint-started', data);
    await deliverWebhook('sprint.started', { ...data, sprintId: sprint.id, boardId: sprint.boardId, projectId: project[0]?.id });
  } else {
    const completedIssues = await db
      .select({ count: schema.sprintIssues.issueId })
      .from(schema.sprintIssues)
      .where(eq(schema.sprintIssues.sprintId, sprint.id));

    const data = {
      sprintName: sprint.name,
      goal: sprint.goal || undefined,
      boardName: board[0]?.name || 'Unknown',
      completedIssues: completedIssues.length,
      totalIssues: completedIssues.length,
      sprintUrl: `${baseUrl}/boards/${sprint.boardId}`,
    };
    await queueEmails(users.map((u) => u.email), 'sprint-closed', data);
    await deliverWebhook('sprint.closed', { ...data, sprintId: sprint.id, boardId: sprint.boardId, projectId: project[0]?.id });
  }
}
