/**
 * Admin diagnostics ("helpers"): explain a permission verdict and a notification decision.
 * Both reuse the real evaluation code (permissions/evaluate.ts, services/notifications.ts); nothing here
 * decides anything on its own, it only labels what the real code found.
 */
import { and, eq, or } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'
import { GLOBAL_PERMISSIONS } from '../rbac/types'
import { evaluateGlobal, evaluateIssueAccess, evaluateProject, type Reason } from '../permissions/evaluate'
import { ISSUE_EVENT_RULES, recipientOptionsFor, resolveIssueRecipients, type IssueEvent, type RecipientRule } from '../services/notifications'
import { getSmtpConfig } from '../services/email'

type User = typeof schema.users.$inferSelect

export class HelperError extends Error {
  constructor(public status: 400 | 404, message: string) { super(message) }
}

export interface PermissionExplanation {
  allowed: boolean
  permission: string
  user: { id: number; username: string; displayName: string; active: boolean }
  scope: { type: 'global' | 'project' | 'issue'; projectKey?: string; projectName?: string; issueKey?: string }
  reasons: Reason[]
}

export async function findUser(userId: number): Promise<User> {
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  if (!rows[0]) throw new HelperError(404, 'User not found')
  return rows[0]
}

async function findIssue(issueKey: string) {
  const rows = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, issueKey)).limit(1)
  if (!rows[0]) throw new HelperError(404, `Issue ${issueKey} not found`)
  return rows[0]
}

export async function explainPermission(input: { userId: number; projectKey?: string; issueKey?: string; permission: string }): Promise<PermissionExplanation> {
  const user = await findUser(input.userId)
  const permission = input.permission
  let projectId: number | null = null
  let issueId: number | null = null
  let scope: PermissionExplanation['scope'] = { type: 'global' }
  if (input.issueKey) {
    const issue = await findIssue(input.issueKey)
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, issue.projectId)).limit(1)
    projectId = issue.projectId
    issueId = issue.id
    scope = { type: 'issue', issueKey: issue.issueKey, projectKey: project?.projectKey, projectName: project?.name }
  } else if (input.projectKey) {
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, input.projectKey)).limit(1)
    if (!project) throw new HelperError(404, `Project ${input.projectKey} not found`)
    projectId = project.id
    scope = { type: 'project', projectKey: project.projectKey, projectName: project.name }
  } else if (!(GLOBAL_PERMISSIONS as readonly string[]).includes(permission)) {
    throw new HelperError(400, `${permission} is a project permission: give a projectKey or an issueKey`)
  }

  const user_ = { id: user.id, username: user.username, displayName: user.displayName, active: user.active !== false }
  const notes: Reason[] = []
  if (!user_.active) notes.push({ kind: 'inactive', granted: false, decisive: false, text: 'This account is deactivated. The permission check itself ignores that, but the user cannot sign in.', link: '/admin?tab=users' })

  let ev: { allowed: boolean; reasons: Reason[] }
  if (scope.type === 'issue') ev = await evaluateIssueAccess(user, projectId!, permission, true, issueId!)
  else if (scope.type === 'project') ev = await evaluateProject(user, projectId!, permission, true)
  else ev = await evaluateGlobal(user, permission, true)
  return { allowed: ev.allowed, permission, user: user_, scope, reasons: [...ev.reasons, ...notes] }
}

export const NOTIFICATION_EVENTS = Object.entries(ISSUE_EVENT_RULES).map(([id, v]) => ({ id: id as IssueEvent, label: v.label }))

export interface NotificationExplanation {
  /** The recipient rules match and the user has an e-mail address: a message is queued for them. */
  notified: boolean
  /** notified, and a mail server is configured so the message can actually leave. */
  deliverable: boolean
  event: { id: string; label: string }
  issueKey: string
  user: { id: number; username: string; displayName: string; email: string; active: boolean }
  reasons: Reason[]
}

const RULE_LABEL: Record<RecipientRule, string> = { assignee: 'assignee', reporter: 'reporter', watcher: 'watcher', 'project-lead': 'project lead' }

export async function explainNotification(input: { issueKey: string; event: string; userId: number; actorId?: number }): Promise<NotificationExplanation> {
  if (!(input.event in ISSUE_EVENT_RULES)) throw new HelperError(400, `Unknown event "${input.event}". Known events: ${Object.keys(ISSUE_EVENT_RULES).join(', ')}`)
  const event = input.event as IssueEvent
  const def = ISSUE_EVENT_RULES[event]
  const issue = await findIssue(input.issueKey)
  const user = await findUser(input.userId)
  const actor = input.actorId ? await findUser(input.actorId) : null

  // The real resolution, with the real options for this event.
  const { matches, excluded, hidden } = await resolveIssueRecipients(issue.id, recipientOptionsFor(event, actor?.id))
  const matched = matches.get(user.id) ?? []

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, issue.projectId)).limit(1)
  const reasons: Reason[] = []
  const rule = (kind: RecipientRule, text: string, yes: boolean) => reasons.push({ kind, granted: yes, decisive: true, text, link: kind === 'project-lead' ? `/projects/${project?.projectKey}/settings` : `/issues/${issue.issueKey}` })
  const watching = (await db.select().from(schema.watchers).where(and(eq(schema.watchers.issueId, issue.id), eq(schema.watchers.userId, user.id))).limit(1)).length > 0

  for (const r of def.rules) {
    const yes = matched.includes(r) || (excluded.has(user.id) && ((r === 'assignee' && issue.assigneeId === user.id) || (r === 'reporter' && issue.reporterId === user.id) || (r === 'project-lead' && project?.leadId === user.id) || (r === 'watcher' && watching)))
    const text = r === 'assignee' ? (yes ? `Is the assignee of ${issue.issueKey}.` : issue.assigneeId ? `Is not the assignee of ${issue.issueKey}.` : `${issue.issueKey} has no assignee.`)
      : r === 'reporter' ? (yes ? `Is the reporter of ${issue.issueKey}.` : `Is not the reporter of ${issue.issueKey}.`)
      : r === 'watcher' ? (yes ? `Watches ${issue.issueKey}.` : `Does not watch ${issue.issueKey}.`)
      : (yes ? `Is the lead of project ${project?.projectKey}.` : project?.leadId ? `Is not the lead of project ${project?.projectKey}.` : `Project ${project?.projectKey} has no lead.`)
    rule(r, `${text} The "${RULE_LABEL[r]}" rule applies to "${def.label}".`, yes)
  }
  if (hidden.has(user.id)) {
    reasons.push({ kind: 'security', granted: false, decisive: true, text: `${issue.issueKey} has an issue security level and this user is not a member of it, so they are never e-mailed about it.`, link: '/admin/issue-security' })
  }
  const anyRule = reasons.some((r) => r.granted) || hidden.has(user.id)
  if (!def.rules.length || !reasons.length) reasons.push({ kind: 'no-rule', granted: false, decisive: true, text: `No rule sends mail for "${def.label}".` })
  if (excluded.has(user.id)) {
    reasons.push({ kind: 'actor', granted: false, decisive: true, text: `Caused this event (${actor?.displayName}), and the person who performs "${def.label}" is not notified about their own action.` })
  } else if (def.excludeActor && !actor) {
    reasons.push({ kind: 'actor', granted: true, decisive: false, text: `No acting user given: for "${def.label}" the person who makes the change is never notified. Pass an actor to check that case.` })
  }

  const hasEmail = !!user.email && /.+@.+/.test(user.email)
  const ruleHit = matched.length > 0
  reasons.push({ kind: 'email', granted: hasEmail, decisive: ruleHit || anyRule, text: hasEmail ? `Has an e-mail address (${user.email}).` : 'Has no usable e-mail address, so nothing can be sent.', link: '/admin?tab=users' })
  const smtp = await getSmtpConfig().catch(() => null)
  reasons.push({ kind: 'mail-server', granted: !!smtp, decisive: false, text: smtp ? 'A mail server is configured.' : 'No mail server is configured: messages are queued but cannot be delivered.', link: '/admin/system' })
  if (user.active === false) reasons.push({ kind: 'inactive', granted: false, decisive: false, text: 'This account is deactivated. Recipients are not filtered by that, so mail is still queued for it.', link: '/admin?tab=users' })
  reasons.push({ kind: 'preferences', granted: true, decisive: false, text: 'There are no per-user notification preferences, mute or subscription settings in this version: every matching rule sends mail.', link: '/profile' })

  // The notification scheme is configuration only for now; show what it says so an admin can compare.
  const schemes = await db.select().from(schema.notificationSchemes)
    .where(or(eq(schema.notificationSchemes.projectId, issue.projectId), eq(schema.notificationSchemes.isDefault, true)))
  const scheme = schemes.find((s) => s.projectId === issue.projectId) ?? schemes[0]
  if (scheme) {
    const [row] = await db.select().from(schema.notificationSchemeEvents)
      .where(and(eq(schema.notificationSchemeEvents.schemeId, scheme.id), eq(schema.notificationSchemeEvents.eventType, event))).limit(1)
    if (row) {
      const on = [row.notifyAssignee && 'assignee', row.notifyReporter && 'reporter', row.notifyWatchers && 'watchers', row.notifyProjectLead && 'project lead', row.notifyAllAdmins && 'all admins', row.notifyCurrentUser && 'current user'].filter(Boolean)
      reasons.push({ kind: 'scheme', granted: true, decisive: false, text: `Notification scheme "${scheme.name}" lists ${on.length ? on.join(', ') : 'nobody'} for this event. The mail sender currently applies the built-in rules above and does not read the scheme.`, link: '/admin/notifications' })
    }
  }

  const notified = ruleHit && hasEmail
  return {
    notified, deliverable: notified && !!smtp,
    event: { id: event, label: def.label }, issueKey: issue.issueKey,
    user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email, active: user.active !== false },
    reasons,
  }
}
