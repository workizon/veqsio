/**
 * Approval persistence and side effects. Pure rules are in engine.ts.
 *
 * Concurrency: every state change locks the approval row (SELECT ... FOR UPDATE) inside a transaction, so two
 * simultaneous last decisions are serialised: the first one completes the approval, the second one finds it no
 * longer pending and is answered with 409. Completion (status change) therefore happens exactly once, and so do
 * the follow-up actions (emails, webhook, auto-transition), which run after the transaction commits.
 */
import { usersWhoCanSee } from '../security/issue-security'
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'
import {
  evaluate, validateRuleSpec, evaluateAutoRules, parseAutoRule, computeExpiry, firstReminderAt, isExpired,
  type Rule, type RuleSpec, type DecisionValue, type AutoRule,
} from './engine'
import { queueEmails } from '../services/email'
import { deliverWebhook } from '../services/webhooks'
import { recordAudit } from '../audit/log'

export class ApprovalError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) { super(message) }
}

type Tx = any
export type ApprovalRow = typeof schema.approvals.$inferSelect
export type TemplateRow = typeof schema.approvalTemplates.$inferSelect

const baseUrl = () => process.env.WEB_URL || 'http://localhost:3001'
export const asIds = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [])

/* ------------------------------------------------------------------ */
/*  Approver resolution                                                 */
/* ------------------------------------------------------------------ */

/** Active users from the given user ids plus the members of the given groups, de-duplicated. */
export async function resolveApproverIds(ex: Tx, userIds: number[], groupIds: number[], excludeUserId?: number | null): Promise<number[]> {
  const out = new Set<number>()
  if (userIds.length) {
    const rows = await ex.select({ id: schema.users.id }).from(schema.users)
      .where(and(inArray(schema.users.id, userIds), or(eq(schema.users.active, true), isNull(schema.users.active))))
    rows.forEach((r: any) => out.add(r.id))
  }
  if (groupIds.length) {
    const rows = await ex.select({ id: schema.users.id }).from(schema.userGroups)
      .innerJoin(schema.users, eq(schema.users.id, schema.userGroups.userId))
      .where(and(inArray(schema.userGroups.groupId, groupIds), or(eq(schema.users.active, true), isNull(schema.users.active))))
    rows.forEach((r: any) => out.add(r.id))
  }
  // Separation of duties: whoever requests an approval cannot be one of its approvers.
  if (excludeUserId != null) out.delete(excludeUserId)
  return [...out].sort((a, b) => a - b)
}

/* ------------------------------------------------------------------ */
/*  Creation                                                            */
/* ------------------------------------------------------------------ */

export interface AdHocApproval {
  name: string
  userIds: number[]
  groupIds: number[]
  rule: Rule
  threshold?: number | null
  reminderIntervalHours?: number | null
  expiryHours?: number | null
}

export interface CreateParams {
  issueId: number
  createdBy: number | null
  template?: TemplateRow
  adHoc?: AdHocApproval
  /** What to do when a pending approval from the same template exists on the issue. */
  onDuplicate?: 'throw' | 'skip'
}

export interface CreateResult { approval: ApprovalRow | null; after: Array<() => Promise<void>> }

/** Creates an approval inside the caller's transaction; side effects are returned as `after` callbacks to run post-commit. */
export async function createApproval(tx: Tx, p: CreateParams): Promise<CreateResult> {
  const [issue] = await tx.select().from(schema.issues).where(eq(schema.issues.id, p.issueId)).for('update').limit(1)
  if (!issue) throw new ApprovalError(404, 'Issue not found')

  const t = p.template
  const cfg = t
    ? {
        name: t.name, userIds: asIds(t.approverUserIds), groupIds: asIds(t.approverGroupIds), rule: t.rule as Rule, threshold: t.ruleThreshold,
        reminderIntervalHours: t.reminderIntervalHours, expiryHours: t.expiryHours,
        onApproved: t.onApprovedTransitionId, onDeclined: t.onDeclinedTransitionId,
        autoApprove: parseAutoRule(t.autoApproveWhen), autoDecline: parseAutoRule(t.autoDeclineWhen),
      }
    : p.adHoc
      ? {
          name: p.adHoc.name, userIds: p.adHoc.userIds, groupIds: p.adHoc.groupIds, rule: p.adHoc.rule, threshold: p.adHoc.threshold ?? null,
          reminderIntervalHours: p.adHoc.reminderIntervalHours ?? null, expiryHours: p.adHoc.expiryHours ?? null,
          onApproved: null, onDeclined: null, autoApprove: { ok: true, rule: null } as const, autoDecline: { ok: true, rule: null } as const,
        }
      : null
  if (!cfg) throw new ApprovalError(400, 'A template or ad-hoc approvers are required')

  if (t) {
    const [dup] = await tx.select({ id: schema.approvals.id }).from(schema.approvals)
      .where(and(eq(schema.approvals.issueId, p.issueId), eq(schema.approvals.templateId, t.id), eq(schema.approvals.status, 'pending'))).limit(1)
    if (dup) {
      if (p.onDuplicate === 'skip') return { approval: null, after: [] }
      throw new ApprovalError(409, `An approval '${t.name}' is already pending on this issue`)
    }
  }

  const approverIds = await resolveApproverIds(tx, cfg.userIds, cfg.groupIds, p.createdBy)
  if (approverIds.length === 0) throw new ApprovalError(400, 'No eligible approvers (the requester cannot approve their own request)')
  const spec: RuleSpec = { rule: cfg.rule, threshold: cfg.threshold }
  const specErr = validateRuleSpec(spec, approverIds.length)
  if (specErr) throw new ApprovalError(400, specErr)

  const [prio] = issue.priorityId ? await tx.select({ n: schema.priorities.name }).from(schema.priorities).where(eq(schema.priorities.id, issue.priorityId)).limit(1) : [undefined]
  const [itype] = await tx.select({ n: schema.issueTypes.name }).from(schema.issueTypes).where(eq(schema.issueTypes.id, issue.issueTypeId)).limit(1)
  const auto = evaluateAutoRules(
    cfg.autoApprove.ok ? cfg.autoApprove.rule : null, cfg.autoDecline.ok ? cfg.autoDecline.rule : null,
    { priority: prio?.n, issuetype: itype?.n },
  )

  const now = new Date()
  const [row] = await tx.insert(schema.approvals).values({
    issueId: p.issueId, templateId: t?.id ?? null, name: cfg.name.slice(0, 120),
    status: auto ?? 'pending', rule: cfg.rule, ruleThreshold: cfg.threshold ?? null,
    completedBy: auto ? 'auto_rule' : null, decidedAt: auto ? now : null,
    onApprovedTransitionId: cfg.onApproved ?? null, onDeclinedTransitionId: cfg.onDeclined ?? null,
    reminderIntervalHours: cfg.reminderIntervalHours ?? null,
    nextReminderAt: auto ? null : firstReminderAt(now, cfg.reminderIntervalHours),
    expiresAt: auto ? null : computeExpiry(now, cfg.expiryHours),
    createdBy: p.createdBy,
  }).returning() as ApprovalRow[]
  await tx.insert(schema.approvalApprovers).values(approverIds.map((userId) => ({ approvalId: row.id, userId })))
  await tx.insert(schema.issueHistory).values({
    issueId: p.issueId, fieldName: 'approval', oldValue: null,
    newValue: auto ? `${row.name}: ${auto} (automatic rule)` : `${row.name}: requested`, authorId: p.createdBy,
  })

  const after: Array<() => Promise<void>> = []
  if (auto) after.push(() => afterCompleted(row.id, p.createdBy))
  else after.push(() => notifyRequested(row.id))
  return { approval: row, after }
}

/* ------------------------------------------------------------------ */
/*  Decisions                                                           */
/* ------------------------------------------------------------------ */

export interface DecideOptions { scopeDeskId?: number }

export async function recordDecision(approvalId: number, userId: number, decision: DecisionValue, comment: string | null | undefined, opts: DecideOptions = {}) {
  const result = await db.transaction(async (tx) => {
    const [a] = await tx.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)).for('update').limit(1)
    if (!a) throw new ApprovalError(404, 'Approval not found')
    // Only assigned approvers may see or decide: everything else is "not found" (no enumeration).
    const [mine] = await tx.select().from(schema.approvalApprovers)
      .where(and(eq(schema.approvalApprovers.approvalId, approvalId), eq(schema.approvalApprovers.userId, userId))).limit(1)
    if (!mine) throw new ApprovalError(404, 'Approval not found')
    if (opts.scopeDeskId !== undefined) {
      const [r] = await tx.select({ id: schema.serviceRequests.id }).from(schema.serviceRequests)
        .where(and(eq(schema.serviceRequests.issueId, a.issueId), eq(schema.serviceRequests.serviceDeskId, opts.scopeDeskId))).limit(1)
      if (!r) throw new ApprovalError(404, 'Approval not found')
    }
    if (a.status === 'pending' && isExpired(a.expiresAt, new Date())) {
      await tx.update(schema.approvals).set({ status: 'expired', decidedAt: new Date(), completedBy: 'expiry', nextReminderAt: null }).where(eq(schema.approvals.id, a.id))
      return { expiredNow: true as const, a }
    }
    if (a.status !== 'pending') throw new ApprovalError(409, `This approval is already ${a.status}`)

    const [dup] = await tx.select({ id: schema.approvalDecisions.id }).from(schema.approvalDecisions)
      .where(and(eq(schema.approvalDecisions.approvalId, a.id), eq(schema.approvalDecisions.approverId, userId))).limit(1)
    if (dup) throw new ApprovalError(409, 'You have already decided on this approval')

    await tx.insert(schema.approvalDecisions).values({ approvalId: a.id, approverId: userId, decision, comment: comment?.trim() || null })
    const approvers = (await tx.select().from(schema.approvalApprovers).where(eq(schema.approvalApprovers.approvalId, a.id))).map((r: any) => r.userId)
    const decisions = await tx.select().from(schema.approvalDecisions).where(eq(schema.approvalDecisions.approvalId, a.id))
    const outcome = evaluate({ rule: a.rule as Rule, threshold: a.ruleThreshold }, approvers, decisions.map((d: any) => ({ approverId: d.approverId, decision: d.decision })))
    if (outcome === 'pending') return { expiredNow: false as const, a, completed: null }
    await tx.update(schema.approvals).set({ status: outcome, decidedAt: new Date(), completedBy: 'decisions', nextReminderAt: null }).where(eq(schema.approvals.id, a.id))
    await tx.insert(schema.issueHistory).values({ issueId: a.issueId, fieldName: 'approval', oldValue: 'pending', newValue: `${a.name}: ${outcome}`, authorId: userId })
    return { expiredNow: false as const, a, completed: outcome }
  })

  if (result.expiredNow) {
    await afterCompleted(result.a.id, null)
    throw new ApprovalError(409, 'This approval has expired')
  }
  void recordAudit({ actorId: userId, action: 'approval.decision', targetType: 'approval', target: String(approvalId), details: { decision, completed: result.completed } })
  if (result.completed) await afterCompleted(approvalId, userId)
  return { approvalId, completed: result.completed }
}

/** Cancels a pending approval. Authorisation is the caller's job; this only enforces the state machine. */
export async function cancelApproval(approvalId: number, actorId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [a] = await tx.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)).for('update').limit(1)
    if (!a) throw new ApprovalError(404, 'Approval not found')
    if (a.status !== 'pending') throw new ApprovalError(409, `This approval is already ${a.status}`)
    await tx.update(schema.approvals).set({ status: 'cancelled', decidedAt: new Date(), completedBy: 'cancel', nextReminderAt: null }).where(eq(schema.approvals.id, a.id))
    await tx.insert(schema.issueHistory).values({ issueId: a.issueId, fieldName: 'approval', oldValue: 'pending', newValue: `${a.name}: cancelled`, authorId: actorId })
  })
  void recordAudit({ actorId, action: 'approval.cancel', targetType: 'approval', target: String(approvalId) })
}

/** Marks one approval expired if (still) due. Returns true when it transitioned. */
export async function expireApproval(approvalId: number, now = new Date()): Promise<boolean> {
  const done = await db.transaction(async (tx) => {
    const [a] = await tx.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)).for('update').limit(1)
    if (!a || a.status !== 'pending' || !isExpired(a.expiresAt, now)) return false
    await tx.update(schema.approvals).set({ status: 'expired', decidedAt: now, completedBy: 'expiry', nextReminderAt: null }).where(eq(schema.approvals.id, a.id))
    await tx.insert(schema.issueHistory).values({ issueId: a.issueId, fieldName: 'approval', oldValue: 'pending', newValue: `${a.name}: expired`, authorId: null })
    return true
  })
  if (done) await afterCompleted(approvalId, null)
  return done
}

/* ------------------------------------------------------------------ */
/*  Side effects (post-commit, best effort)                             */
/* ------------------------------------------------------------------ */

async function context(approvalId: number) {
  const [a] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)).limit(1)
  if (!a) return null
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.id, a.issueId)).limit(1)
  if (!issue) return null
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, issue.projectId)).limit(1)
  const approvers = await db.select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
    .from(schema.approvalApprovers).innerJoin(schema.users, eq(schema.users.id, schema.approvalApprovers.userId))
    .where(eq(schema.approvalApprovers.approvalId, a.id))
  const requester = a.createdBy ? (await db.select().from(schema.users).where(eq(schema.users.id, a.createdBy)).limit(1))[0] : undefined
  return { a, issue, project, approvers, requester }
}

const fire = (event: 'approval.requested' | 'approval.decided', payload: Record<string, any>) => {
  void deliverWebhook(event, payload).catch((e) => console.error('[approvals] webhook failed', e?.message))
}

export async function notifyRequested(approvalId: number, reminder = false, onlyUserIds?: number[]): Promise<void> {
  try {
    const ctx = await context(approvalId)
    if (!ctx) return
    const { a, issue, project, approvers, requester } = ctx
    const seeing = await usersWhoCanSee(issue.id, approvers.map((u) => u.id)) // issue security: no mail to people who cannot see the issue
    const to = approvers.filter((u) => seeing.has(u.id) && (!onlyUserIds || onlyUserIds.includes(u.id))).map((u) => u.email)
    await queueEmails(to, 'approval-requested', {
      issueKey: issue.issueKey, summary: issue.summary, projectName: project?.name ?? '', approvalName: a.name,
      requesterName: requester?.displayName ?? 'Someone', reminder, approvalsUrl: `${baseUrl()}/approvals`,
    })
    if (!reminder) {
      fire('approval.requested', {
        projectId: issue.projectId, issueId: issue.id, issueKey: issue.issueKey, approvalId: a.id, name: a.name, rule: a.rule,
        approverIds: approvers.map((u) => u.id), requestedBy: a.createdBy,
      })
    }
  } catch (e) {
    console.error('[approvals] notify failed', e)
  }
}

export async function afterCompleted(approvalId: number, actorId: number | null): Promise<void> {
  try {
    const ctx = await context(approvalId)
    if (!ctx) return
    const { a, issue, project, requester } = ctx
    if (a.status === 'pending') return
    if (requester?.email && (await usersWhoCanSee(issue.id, [requester.id])).has(requester.id)) {
      await queueEmails([requester.email], 'approval-decided', {
        issueKey: issue.issueKey, summary: issue.summary, projectName: project?.name ?? '', approvalName: a.name,
        status: a.status, issueUrl: `${baseUrl()}/issues/${issue.issueKey}`,
      })
    }
    fire('approval.decided', {
      projectId: issue.projectId, issueId: issue.id, issueKey: issue.issueKey, approvalId: a.id, name: a.name,
      status: a.status, completedBy: a.completedBy,
    })
    const tid = a.status === 'approved' ? a.onApprovedTransitionId : a.status === 'declined' ? a.onDeclinedTransitionId : null
    if (tid) await autoTransition(issue, tid, a.createdBy ?? actorId)
  } catch (e) {
    console.error('[approvals] completion handling failed', e)
  }
}

/**
 * Runs the configured transition as a system actor: user conditions are skipped (nobody is "the user"), history is
 * authored by nobody, but every validator still runs EXCEPT the approval validator itself. A failing transition is
 * logged and leaves the issue where it is (the approval stays completed).
 */
async function autoTransition(issue: typeof schema.issues.$inferSelect, transitionId: number, actorId: number | null) {
  try {
    const { doTransition } = await import('../workflow/engine')
    await doTransition(issue.id, transitionId, actorId ?? issue.reporterId, {}, { system: true, skipApprovalValidator: true })
    const [{ publishIssueById }, { invalidateIssueKeyCache }, { invalidateIssueCache }] = await Promise.all([
      import('../realtime/publish'), import('../issues/service'), import('../middleware/cache'),
    ])
    publishIssueById('issue.transitioned', issue.id, actorId)
    await invalidateIssueKeyCache(issue.issueKey)
    await invalidateIssueCache(issue.issueKey)
  } catch (e: any) {
    console.error(`[approvals] automatic transition ${transitionId} on ${issue.issueKey} failed: ${e?.message}`)
  }
}

/* ------------------------------------------------------------------ */
/*  Workflow validator                                                  */
/* ------------------------------------------------------------------ */

/**
 * "Approval required" check for a transition: the LATEST non-cancelled approval on the issue (optionally only
 * those created from the template named `templateName`) must be approved.
 */
export async function approvalRequiredSatisfied(ex: Tx, issueId: number, templateName?: string): Promise<{ ok: boolean; message: string }> {
  const conds = [eq(schema.approvals.issueId, issueId), ne(schema.approvals.status, 'cancelled')]
  if (templateName) conds.push(eq(schema.approvals.name, templateName))
  const [latest] = await ex.select({ status: schema.approvals.status, name: schema.approvals.name }).from(schema.approvals)
    .where(and(...conds)).orderBy(desc(schema.approvals.id)).limit(1)
  const label = templateName ? `'${templateName}'` : ''
  if (!latest) return { ok: false, message: `Approval ${label} required: none has been requested yet`.replace('  ', ' ') }
  if (latest.status === 'approved') return { ok: true, message: '' }
  return { ok: false, message: `Approval '${latest.name}' is ${latest.status}; it must be approved first` }
}

/* ------------------------------------------------------------------ */
/*  Reads                                                               */
/* ------------------------------------------------------------------ */

export async function serializeApprovals(rows: ApprovalRow[], viewerId: number, opts: { full: boolean }) {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const [approvers, decisions] = await Promise.all([
    db.select({ approvalId: schema.approvalApprovers.approvalId, id: schema.users.id, displayName: schema.users.displayName })
      .from(schema.approvalApprovers).innerJoin(schema.users, eq(schema.users.id, schema.approvalApprovers.userId))
      .where(inArray(schema.approvalApprovers.approvalId, ids)),
    db.select({ approvalId: schema.approvalDecisions.approvalId, approverId: schema.approvalDecisions.approverId, decision: schema.approvalDecisions.decision, comment: schema.approvalDecisions.comment, decidedAt: schema.approvalDecisions.decidedAt })
      .from(schema.approvalDecisions).where(inArray(schema.approvalDecisions.approvalId, ids)).orderBy(asc(schema.approvalDecisions.id)),
  ])
  return rows.map((r) => {
    const aps = approvers.filter((x) => x.approvalId === r.id)
    const ds = decisions.filter((x) => x.approvalId === r.id)
    const mine = ds.find((d) => d.approverId === viewerId)
    const nameOf = (id: number) => aps.find((x) => x.id === id)?.displayName ?? null
    return {
      id: r.id, issueId: r.issueId, templateId: r.templateId, name: r.name, status: r.status, rule: r.rule, ruleThreshold: r.ruleThreshold,
      completedBy: r.completedBy, createdBy: r.createdBy, created: r.createdAt, decided: r.decidedAt, expires: r.expiresAt,
      isApprover: aps.some((x) => x.id === viewerId),
      myDecision: mine ? { decision: mine.decision, comment: mine.comment, decided: mine.decidedAt } : null,
      canDecide: r.status === 'pending' && aps.some((x) => x.id === viewerId) && !mine && !isExpired(r.expiresAt, new Date()),
      ...(opts.full
        ? {
            approvers: aps.map((x) => ({ id: x.id, displayName: x.displayName, decided: ds.some((d) => d.approverId === x.id) })),
            decisions: ds.map((d) => ({ approverId: d.approverId, approver: nameOf(d.approverId), decision: d.decision, comment: d.comment, decided: d.decidedAt })),
          }
        : { approverCount: aps.length }),
    }
  })
}

export async function pendingForUser(userId: number, startAt: number, maxResults: number) {
  const where = and(
    eq(schema.approvals.status, 'pending'),
    sql`${schema.approvals.id} in (select approval_id from approval_approvers where user_id = ${userId})`,
    sql`not exists (select 1 from approval_decisions d where d.approval_id = ${schema.approvals.id} and d.approver_id = ${userId})`,
    sql`(${schema.approvals.expiresAt} is null or ${schema.approvals.expiresAt} > now())`,
  )
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.approvals).where(where)
  const rows = await db.select({
    a: schema.approvals, issueKey: schema.issues.issueKey, summary: schema.issues.summary, projectId: schema.issues.projectId,
    projectKey: schema.projects.projectKey, projectName: schema.projects.name,
  }).from(schema.approvals)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.approvals.issueId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.issues.projectId))
    .where(where).orderBy(asc(schema.approvals.createdAt), asc(schema.approvals.id)).limit(maxResults).offset(startAt)
  return { total: n, rows }
}
