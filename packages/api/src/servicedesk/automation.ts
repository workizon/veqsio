/**
 * Service desk automation engine. A rule fires once per request (ledger: sd_automation_runs), except the
 * "customer replied" trigger, which fires on every reply to a resolved request. Rules act as the user who created them,
 * so history, comments and transitions have a real author and the usual workflow conditions still apply.
 */
import { and, asc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { computeSlas } from './service'
import { queueEmails } from '../services/email'
import { usersWhoCanSee } from '../security/issue-security'
import { getAvailableTransitions, doTransition } from '../workflow/engine'
import { updateIssue } from '../issues/service'
import { slaPercentReached, waitingExpired, renderRuleText, conditionsMatch, type RuleConditions } from './automation-rules'
import { invalidateIssueCache } from '../middleware/cache'

type Rule = typeof schema.sdAutomationRules.$inferSelect
type Issue = typeof schema.issues.$inferSelect
type Desk = typeof schema.serviceDesks.$inferSelect

const baseUrl = () => (process.env.BASE_URL || process.env.WEB_URL || 'http://localhost:3001').replace(/\/+$/, '')

async function recipients(desk: Desk, issue: Issue): Promise<string[]> {
  let ids: number[] = issue.assigneeId ? [issue.assigneeId] : []
  if (ids.length === 0) ids = (await db.select({ id: schema.serviceDeskAgents.userId }).from(schema.serviceDeskAgents).where(eq(schema.serviceDeskAgents.serviceDeskId, desk.id))).map((r) => r.id)
  if (ids.length) { const can = await usersWhoCanSee(issue.id, ids); ids = ids.filter((i) => can.has(i)) }
  if (!ids.length) return []
  return (await db.select({ e: schema.users.email }).from(schema.users).where(and(inArray(schema.users.id, ids), eq(schema.users.active, true)))).map((r) => r.e)
}

/** Runs one rule's action on one request. Returns a short outcome text; throws on failure. */
export async function applyAction(rule: Rule, desk: Desk, issue: Issue, vars: { days?: number | null; slaName?: string } = {}): Promise<string> {
  const p = (rule.params ?? {}) as { userId?: number; priorityId?: number; status?: string; text?: string; labels?: string[]; requestTypeId?: number }
  const actor = rule.actorId
  if (!actor && rule.action !== 'notify') throw new Error('The rule has no acting user (its creator was deleted)')
  switch (rule.action) {
    case 'notify': {
      const to = await recipients(desk, issue)
      if (!to.length) return 'nobody to notify'
      const lines = [rule.name, ...(vars.slaName ? [`SLA: ${vars.slaName}`] : [])]
      await queueEmails(to, 'module-notice', { heading: `Service desk rule: ${rule.name}`, lines, issueKey: issue.issueKey, summary: issue.summary, url: `${baseUrl()}/issues/${issue.issueKey}`, actionLabel: 'Open the request' })
      return `notified ${to.length}`
    }
    case 'reassign':
      await updateIssue(issue.id, { assigneeId: p.userId! }, actor!)
      return `reassigned to user ${p.userId}`
    case 'priority':
      await updateIssue(issue.id, { priorityId: p.priorityId! }, actor!)
      return `priority set to ${p.priorityId}`
    case 'comment': {
      await db.insert(schema.comments).values({ issueId: issue.id, body: renderRuleText(p.text!, { key: issue.issueKey, days: vars.days }), authorId: actor!, isInternal: false })
      return 'commented'
    }
    case 'transition': {
      const wanted = p.status!.trim().toLowerCase()
      const available = await getAvailableTransitions(issue.id, actor!)
      const t = available.find((a: any) => a.to?.name?.toLowerCase() === wanted || a.name.toLowerCase() === wanted)
      if (!t) throw new Error(`No transition to "${p.status}" is available from the current status`)
      const comment = p.text ? renderRuleText(p.text, { key: issue.issueKey, days: vars.days }) : undefined
      await doTransition(issue.id, t.id, actor!, {}, { comment, system: true })
      return `moved to ${p.status}`
    }
    case 'label': {
      const have = (await db.select({ name: schema.labels.name }).from(schema.issueLabels).innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId)).where(eq(schema.issueLabels.issueId, issue.id))).map((l) => l.name)
      await updateIssue(issue.id, { labels: [...new Set([...have, ...(p.labels ?? [])])] }, actor!)
      return `labelled ${(p.labels ?? []).join(', ')}`
    }
    case 'request_type':
      await db.update(schema.serviceRequests).set({ requestTypeId: p.requestTypeId! }).where(eq(schema.serviceRequests.issueId, issue.id))
      return `request type set to ${p.requestTypeId}`
    default:
      throw new Error(`Unknown action: ${rule.action}`)
  }
}

async function claim(rule: Rule, issueId: number): Promise<number | null> {
  const [row] = await db.insert(schema.sdAutomationRuns).values({ ruleId: rule.id, issueId }).onConflictDoNothing().returning({ id: schema.sdAutomationRuns.id })
  return row?.id ?? null
}

async function finish(runId: number, outcome: string) {
  await db.update(schema.sdAutomationRuns).set({ outcome: outcome.slice(0, 500) }).where(eq(schema.sdAutomationRuns.id, runId))
}

async function execute(rule: Rule, desk: Desk, issue: Issue, vars: { days?: number | null; slaName?: string } = {}) {
  const runId = await claim(rule, issue.id)
  if (runId === null) return false // already done for this request
  try {
    await finish(runId, await applyAction(rule, desk, issue, vars))
    await invalidateIssueCache(issue.issueKey)
  } catch (e) {
    await finish(runId, `failed: ${(e as Error).message}`)
    console.error('[servicedesk] automation rule failed:', rule.id, (e as Error).message)
  }
  return true
}

/** Polled by a job: SLA percentage, SLA breach and waiting-for-customer rules. Returns the number of actions run. */
export async function runDeskAutomations(now = Date.now()): Promise<number> {
  let fired = 0
  const rules = await db.select().from(schema.sdAutomationRules).where(eq(schema.sdAutomationRules.enabled, true))
  if (rules.length === 0) return 0
  const desks = await db.select().from(schema.serviceDesks).where(and(eq(schema.serviceDesks.enabled, true), inArray(schema.serviceDesks.id, [...new Set(rules.map((r) => r.serviceDeskId))])))
  for (const desk of desks) {
    const deskRules = rules.filter((r) => r.serviceDeskId === desk.id && r.trigger !== 'customer_reply')
    if (deskRules.length === 0) continue
    const open = await db.select({ issue: schema.issues }).from(schema.serviceRequests)
      .innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
      .where(and(eq(schema.serviceRequests.serviceDeskId, desk.id), isNull(schema.issues.resolutionId), isNull(schema.issues.resolvedAt))).limit(5000)
    if (open.length === 0) continue

    if (deskRules.some((r) => r.trigger === 'sla_percent' || r.trigger === 'sla_breached')) {
      const slas = await computeSlas(desk, open.map((o) => o.issue.id), now)
      for (const { issue } of open) {
        for (const sla of slas.get(issue.id) ?? []) {
          if (sla.stoppedAt) continue
          for (const rule of deskRules) {
            const p = (rule.params ?? {}) as { slaId?: number }
            if (p.slaId && p.slaId !== sla.slaId) continue
            const due = rule.trigger === 'sla_breached' ? sla.breached : rule.trigger === 'sla_percent' ? !sla.breached && slaPercentReached(sla.elapsedMs, sla.targetMs, rule.threshold ?? 100) : false
            if (due && (await execute(rule, desk, issue, { slaName: sla.name }))) fired++
          }
        }
      }
    }

    const waitingRules = deskRules.filter((r) => r.trigger === 'waiting_days')
    if (waitingRules.length) {
      const waitingIds = (await db.select({ id: schema.statuses.id }).from(schema.statuses).where(sql`lower(trim(${schema.statuses.name})) = 'waiting for customer'`)).map((s) => s.id)
      const waiting = open.filter((o) => waitingIds.includes(o.issue.statusId)).map((o) => o.issue)
      if (waiting.length) {
        // When each request entered the waiting status: the newest status change into it.
        const hist = await db.select({ issueId: schema.issueHistory.issueId, at: sql<Date>`max(${schema.issueHistory.createdAt})` }).from(schema.issueHistory)
          .where(and(inArray(schema.issueHistory.issueId, waiting.map((i) => i.id)), eq(schema.issueHistory.fieldName, 'status'), sql`lower(trim(${schema.issueHistory.newValue})) = 'waiting for customer'`))
          .groupBy(schema.issueHistory.issueId)
        const since = new Map(hist.map((h) => [h.issueId, new Date(h.at as any)]))
        for (const issue of waiting) {
          const from = since.get(issue.id) ?? issue.updatedAt ?? issue.createdAt
          if (!from) continue
          for (const rule of waitingRules) {
            if (waitingExpired(from, now, rule.threshold ?? 7) && (await execute(rule, desk, issue, { days: rule.threshold }))) fired++
          }
        }
      }
    }
  }
  return fired
}

/**
 * Called after a request was created (portal, e-mail or on behalf of a customer): runs the "new request" rules whose
 * conditions match. This is the auto-categorisation and auto-prioritisation of incoming requests. Never throws.
 */
export async function onRequestCreated(issueId: number): Promise<number> {
  try {
    const [row] = await db.select({ issue: schema.issues, req: schema.serviceRequests, desk: schema.serviceDesks }).from(schema.serviceRequests)
      .innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
      .innerJoin(schema.serviceDesks, eq(schema.serviceDesks.id, schema.serviceRequests.serviceDeskId))
      .where(eq(schema.serviceRequests.issueId, issueId)).limit(1)
    if (!row) return 0
    const rules = await db.select().from(schema.sdAutomationRules)
      .where(and(eq(schema.sdAutomationRules.serviceDeskId, row.desk.id), eq(schema.sdAutomationRules.enabled, true), eq(schema.sdAutomationRules.trigger, 'request_created'))).orderBy(asc(schema.sdAutomationRules.id))
    let n = 0
    let issue = row.issue
    for (const rule of rules) {
      if (!conditionsMatch(rule.conditions as RuleConditions, { summary: issue.summary, description: issue.description, channel: row.req.channel, requestTypeId: row.req.requestTypeId })) continue
      if (await execute(rule, row.desk, issue)) n++
      const [fresh] = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1)
      if (fresh) issue = fresh
    }
    return n
  } catch (e) {
    console.error('[servicedesk] new-request automation failed:', (e as Error).message)
    return 0
  }
}

/** Called when a customer replies on a request (portal or e-mail): runs "customer replied" rules on resolved requests. */
export async function onCustomerReply(issueId: number): Promise<number> {
  try {
    const [row] = await db.select({ issue: schema.issues, desk: schema.serviceDesks }).from(schema.serviceRequests)
      .innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
      .innerJoin(schema.serviceDesks, eq(schema.serviceDesks.id, schema.serviceRequests.serviceDeskId))
      .where(and(eq(schema.serviceRequests.issueId, issueId), isNotNull(schema.issues.resolutionId))).limit(1)
    if (!row) return 0 // not resolved: nothing to reopen
    const rules = await db.select().from(schema.sdAutomationRules)
      .where(and(eq(schema.sdAutomationRules.serviceDeskId, row.desk.id), eq(schema.sdAutomationRules.enabled, true), eq(schema.sdAutomationRules.trigger, 'customer_reply')))
    let n = 0
    for (const rule of rules) {
      try { await applyAction(rule, row.desk, row.issue); n++ } catch (e) { console.error('[servicedesk] customer-reply rule failed:', rule.id, (e as Error).message) }
    }
    return n
  } catch (e) {
    console.error('[servicedesk] customer-reply automation failed:', (e as Error).message)
    return 0
  }
}
