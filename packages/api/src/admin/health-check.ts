import { isDoneLike } from '../workflow/status-groups'
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { getSmtpConfig } from '../services/email'

export type Severity = 'ok' | 'info' | 'warning' | 'critical'

export interface Check {
  id: string
  severity: Severity
  title: string
  detail: string
  count: number
  /** Up to 10 example items (names / keys). */
  items: string[]
  fix?: { label: string; href: string }
}

const RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, critical: 3 }

/** Overall verdict is the worst severity found. */
export function summarize(checks: Check[]): { status: Severity; counts: Record<Severity, number> } {
  const counts: Record<Severity, number> = { ok: 0, info: 0, warning: 0, critical: 0 }
  let status: Severity = 'ok'
  for (const c of checks) {
    counts[c.severity]++
    if (RANK[c.severity] > RANK[status]) status = c.severity
  }
  return { status, counts }
}

/** Build a check that is "ok" when there are no offenders. */
export function makeCheck(base: Omit<Check, 'severity' | 'count' | 'items' | 'detail'> & { detail: string; okDetail: string; severity: Severity }, offenders: string[]): Check {
  return {
    id: base.id,
    title: base.title,
    fix: base.fix,
    severity: offenders.length ? base.severity : 'ok',
    detail: offenders.length ? base.detail : base.okDetail,
    count: offenders.length,
    items: offenders.slice(0, 10),
  }
}

const take = <T>(rows: T[]) => rows

export async function runHealthChecks(): Promise<Check[]> {
  const checks: Check[] = []

  const projects = await db.select().from(schema.projects)
  const permAssoc = new Set((await db.select({ p: schema.permissionSchemeAssociations.projectId }).from(schema.permissionSchemeAssociations)).map((r) => r.p))
  const wfAssoc = new Set((await db.select({ p: schema.workflowSchemeAssociations.projectId }).from(schema.workflowSchemeAssociations)).map((r) => r.p))

  checks.push(makeCheck({
    id: 'projects-no-permission-scheme', severity: 'warning', title: 'Projects without a permission scheme',
    detail: 'These projects fall back to global permissions only. Assign a permission scheme so project roles and groups apply.',
    okDetail: 'Every project has a permission scheme.', fix: { label: 'Permission schemes', href: '/admin' },
  }, projects.filter((p) => !permAssoc.has(p.id)).map((p) => p.projectKey)))

  checks.push(makeCheck({
    id: 'projects-no-workflow-scheme', severity: 'warning', title: 'Projects without a workflow scheme',
    detail: 'New issues in these projects get a default status and cannot follow a defined workflow. Assign a workflow scheme.',
    okDetail: 'Every project has a workflow scheme.', fix: { label: 'Workflow schemes', href: '/admin' },
  }, projects.filter((p) => !wfAssoc.has(p.id)).map((p) => p.projectKey)))

  checks.push(makeCheck({
    id: 'projects-no-lead', severity: 'info', title: 'Projects without a lead',
    detail: 'Notifications that go to the project lead have no recipient.', okDetail: 'Every project has a lead.',
  }, projects.filter((p) => !p.leadId).map((p) => p.projectKey)))

  // Workflows: statuses that can be entered but never left (excluding "done" statuses, which are normally terminal)
  const transitions = await db.select().from(schema.workflowTransitions)
  const statuses = await db.select().from(schema.statuses)
  const statusById = new Map(statuses.map((s) => [s.id, s]))
  const workflows = await db.select().from(schema.workflows)
  const dead: string[] = []
  for (const wf of workflows) {
    const ts = transitions.filter((t) => t.workflowId === wf.id)
    const hasOut = new Set(ts.filter((t) => t.fromStatusId !== null).map((t) => t.fromStatusId))
    for (const to of new Set(ts.map((t) => t.toStatusId))) {
      const st = statusById.get(to)
      if (st && !isDoneLike(st.category) && !hasOut.has(to)) dead.push(`${wf.name}: ${st.name}`)
    }
  }
  checks.push(makeCheck({
    id: 'workflow-dead-end-statuses', severity: 'warning', title: 'Workflow statuses with no way out',
    detail: 'Issues that reach these (non-done) statuses cannot be transitioned further. Add outgoing transitions.',
    okDetail: 'No dead-end statuses in workflows.', fix: { label: 'Workflows', href: '/admin' },
  }, dead))

  // Open issues sitting in a status that has no outgoing transitions in any workflow
  const outgoing = new Set(transitions.filter((t) => t.fromStatusId !== null).map((t) => t.fromStatusId as number))
  const stuckStatusIds = statuses.filter((s) => !isDoneLike(s.category) && !outgoing.has(s.id)).map((s) => s.id)
  let stuckIssues: string[] = []
  let stuckTotal = 0
  if (stuckStatusIds.length && transitions.length) {
    const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.issues)
      .where(and(inArray(schema.issues.statusId, stuckStatusIds), isNull(schema.issues.resolutionId)))
    stuckTotal = c
    stuckIssues = (await db.select({ k: schema.issues.issueKey }).from(schema.issues)
      .where(and(inArray(schema.issues.statusId, stuckStatusIds), isNull(schema.issues.resolutionId))).limit(10)).map((r) => r.k)
  }
  const stuck = makeCheck({
    id: 'issues-stuck-in-status', severity: 'warning', title: 'Open issues in statuses without transitions',
    detail: 'These issues cannot be moved because their status has no outgoing transition in any workflow (common after a migration).',
    okDetail: 'No open issues are stuck.', fix: { label: 'Workflows', href: '/admin' },
  }, stuckIssues)
  stuck.count = stuckTotal
  checks.push(stuck)

  // Open issues assigned to deactivated users
  const inactive = await db.select({ k: schema.issues.issueKey }).from(schema.issues)
    .innerJoin(schema.users, eq(schema.users.id, schema.issues.assigneeId))
    .where(and(eq(schema.users.active, false), isNull(schema.issues.resolutionId))).limit(10)
  const [{ c: inactiveTotal }] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.issues)
    .innerJoin(schema.users, eq(schema.users.id, schema.issues.assigneeId))
    .where(and(eq(schema.users.active, false), isNull(schema.issues.resolutionId)))
  const inactiveCheck = makeCheck({
    id: 'issues-assigned-to-inactive', severity: 'warning', title: 'Open issues assigned to deactivated users',
    detail: 'Nobody will see or act on these. Reassign them.', okDetail: 'No open issues are assigned to deactivated users.',
    fix: { label: 'People', href: '/people' },
  }, inactive.map((r) => r.k))
  inactiveCheck.count = inactiveTotal
  checks.push(inactiveCheck)

  // Unused custom fields / issue types
  const cfUsage = await db.select({ id: schema.customFieldValues.customFieldId }).from(schema.customFieldValues).groupBy(schema.customFieldValues.customFieldId)
  const usedCf = new Set(cfUsage.map((r) => r.id))
  const fields = await db.select().from(schema.customFields)
  checks.push(makeCheck({
    id: 'custom-fields-unused', severity: 'info', title: 'Custom fields with no values',
    detail: 'Unused fields add clutter to screens. Consider removing them.', okDetail: 'All custom fields are in use.',
    fix: { label: 'Custom fields', href: '/admin' },
  }, take(fields.filter((f) => !usedCf.has(f.id)).map((f) => f.name))))

  const typeUsage = await db.select({ id: schema.issues.issueTypeId }).from(schema.issues).groupBy(schema.issues.issueTypeId)
  const usedTypes = new Set(typeUsage.map((r) => r.id))
  const types = await db.select().from(schema.issueTypes)
  checks.push(makeCheck({
    id: 'issue-types-unused', severity: 'info', title: 'Issue types with no issues',
    detail: 'Consider removing or hiding them from issue type schemes.', okDetail: 'All issue types are in use.',
  }, types.filter((t) => !usedTypes.has(t.id)).map((t) => t.name)))

  // Mail
  const smtp = await getSmtpConfig().catch(() => null)
  checks.push(makeCheck({
    id: 'mail-not-configured', severity: 'warning', title: 'Outgoing mail is not configured',
    detail: 'Notifications, SLA alerts and filter digests are queued but cannot be delivered. Configure an SMTP server.',
    okDetail: 'An SMTP server is configured.', fix: { label: 'Mail server', href: '/admin/system' },
  }, smtp ? [] : ['SMTP']))

  const since = new Date(Date.now() - 24 * 3600_000)
  const [{ c: failedMail }] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.emailQueue)
    .where(and(eq(schema.emailQueue.status, 'failed'), gt(schema.emailQueue.createdAt, since)))
  checks.push(makeCheck({
    id: 'mail-failures', severity: 'warning', title: 'Emails failing to send',
    detail: `${failedMail} email(s) failed in the last 24 hours. Check the SMTP settings and the queue.`, okDetail: 'No email failures in the last 24 hours.',
    fix: { label: 'Mail server', href: '/admin/system' },
  }, failedMail ? [`${failedMail} failed`] : []))

  // Administrators
  const admins = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.username, 'admin'), eq(schema.users.active, true)))
  checks.push(makeCheck({
    id: 'default-admin-account', severity: 'critical', title: 'Default "admin" account is active',
    detail: 'The seeded administrator account has a well-known initial password. Change the password or replace the account with named administrators.',
    okDetail: 'No default administrator account is active.', fix: { label: 'People', href: '/people' },
  }, admins.length ? ['admin'] : []))

  // Failed migrations
  const failedMig = await db.select({ id: schema.migrationSessions.id }).from(schema.migrationSessions)
    .where(inArray(schema.migrationSessions.status, ['failed', 'completed_with_errors'])).limit(10)
  checks.push(makeCheck({
    id: 'migrations-with-errors', severity: 'info', title: 'Migrations that finished with errors',
    detail: 'Review the migration reports and re-run to fix the gaps (re-runs are safe).', okDetail: 'No migration errors recorded.',
    fix: { label: 'Migration', href: '/admin/migration' },
  }, failedMig.map((m) => `session ${m.id}`)))

  return checks
}
