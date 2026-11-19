import { usersWhoCanSee } from '../security/issue-security'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { computeSlas } from './service'
import { queueEmails } from '../services/email'
import { deliverWebhook } from '../services/webhooks'

const BASE_URL = () => (process.env.BASE_URL || process.env.WEB_URL || 'http://localhost:3001').replace(/\/+$/, '')

function minutesText(min: number): string {
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h ${min % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

export interface SlaCheck { breached: number; warned: number }

/** Who hears about a request's SLA: the assignee, or every desk agent when unassigned; never the customer; only people who can see the issue. */
async function recipientsFor(issue: typeof schema.issues.$inferSelect, deskId: number): Promise<string[]> {
  let ids: number[] = issue.assigneeId ? [issue.assigneeId] : []
  if (ids.length === 0) {
    ids = (await db.select({ id: schema.serviceDeskAgents.userId }).from(schema.serviceDeskAgents)
      .where(eq(schema.serviceDeskAgents.serviceDeskId, deskId))).map((r) => r.id)
  }
  if (ids.length) { const can = await usersWhoCanSee(issue.id, ids); ids = ids.filter((i) => can.has(i)) }
  return ids.length
    ? (await db.select({ e: schema.users.email }).from(schema.users).where(and(inArray(schema.users.id, ids), eq(schema.users.active, true)))).map((r) => r.e)
    : []
}

/**
 * Detects SLAs on open requests that reached their warning threshold or were breached, and notifies each once per
 * (request, SLA). `request_sla_states` is the "already notified" ledger: `warned_at` marks the warning, `breached` the
 * breach, so a request that was warned still gets its breach notification later.
 */
export async function checkSla(now = Date.now()): Promise<SlaCheck> {
  const out: SlaCheck = { breached: 0, warned: 0 }
  const desks = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.enabled, true))

  for (const desk of desks) {
    const open = await db.select({ issue: schema.issues, customerId: schema.serviceRequests.customerId })
      .from(schema.serviceRequests)
      .innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
      .where(and(eq(schema.serviceRequests.serviceDeskId, desk.id), isNull(schema.issues.resolutionId), isNull(schema.issues.resolvedAt)))
      .limit(5000)
    if (open.length === 0) continue

    const slas = await computeSlas(desk, open.map((o) => o.issue.id), now)
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, desk.projectId)).limit(1)
    const ledger = await db.select().from(schema.requestSlaStates).where(inArray(schema.requestSlaStates.issueId, open.map((o) => o.issue.id)))
    const seen = new Map(ledger.map((r) => [`${r.issueId}:${r.slaId}`, r]))

    for (const { issue } of open) {
      for (const sla of slas.get(issue.id) ?? []) {
        if (sla.stoppedAt) continue
        const row = seen.get(`${issue.id}:${sla.slaId}`)
        const base = {
          issueKey: issue.issueKey, summary: issue.summary, projectName: project?.name ?? desk.name,
          slaName: sla.name, targetText: minutesText(Math.round(sla.targetMs / 60_000)), issueUrl: `${BASE_URL()}/issues/${issue.issueKey}`,
        }
        const target = Math.round(sla.targetMs / 60_000)

        if (sla.breached) {
          if (row?.breached) continue // already notified
          const claimed = row
            ? await db.update(schema.requestSlaStates).set({ breached: true, elapsedMs: sla.elapsedMs }).where(and(eq(schema.requestSlaStates.id, row.id), eq(schema.requestSlaStates.breached, false))).returning({ id: schema.requestSlaStates.id })
            : await db.insert(schema.requestSlaStates).values({ issueId: issue.id, slaId: sla.slaId, startedAt: issue.createdAt ?? new Date(now), elapsedMs: sla.elapsedMs, targetMinutes: target, breached: true }).onConflictDoNothing().returning({ id: schema.requestSlaStates.id })
          if (claimed.length === 0) continue
          try {
            await queueEmails(await recipientsFor(issue, desk.id), 'sla-breached', base)
            await deliverWebhook('sla.breached', { ...base, projectId: desk.projectId, issueId: issue.id, slaId: sla.slaId })
          } catch (e) { console.error('[servicedesk] SLA breach notification failed', e) }
          out.breached++
        } else if (sla.status === 'warning') {
          if (row) continue // warned before (or breached)
          const claimed = await db.insert(schema.requestSlaStates).values({ issueId: issue.id, slaId: sla.slaId, startedAt: issue.createdAt ?? new Date(now), elapsedMs: sla.elapsedMs, targetMinutes: target, breached: false, warnedAt: new Date(now) }).onConflictDoNothing().returning({ id: schema.requestSlaStates.id })
          if (claimed.length === 0) continue
          const data = { ...base, remainingText: minutesText(Math.max(1, Math.round(sla.remainingMs / 60_000))) }
          try {
            await queueEmails(await recipientsFor(issue, desk.id), 'sla-warning', data)
            await deliverWebhook('sla.warning', { ...data, projectId: desk.projectId, issueId: issue.id, slaId: sla.slaId })
          } catch (e) { console.error('[servicedesk] SLA warning notification failed', e) }
          out.warned++
        }
      }
    }
  }
  return out
}

/** Number of breach notifications sent (kept for callers and tests that only care about breaches). */
export async function checkSlaBreaches(now = Date.now()): Promise<number> {
  return (await checkSla(now)).breached
}
