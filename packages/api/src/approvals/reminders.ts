/**
 * Background job (scheduled every 5 minutes in index.ts): expires overdue approvals and sends reminders to the
 * approvers who have not decided yet. Safe to run on several instances: expiry locks the row, and a reminder is
 * "claimed" with a conditional UPDATE that moves next_reminder_at forward, so it is sent once per interval.
 */
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'
import { isReminderDue, nextReminderAfter, pendingApprovers } from './engine'
import { expireApproval, notifyRequested } from './service'

export async function runApprovalJobs(now = new Date()): Promise<{ expired: number; reminded: number }> {
  let expired = 0
  let reminded = 0

  const overdue = await db.select({ id: schema.approvals.id }).from(schema.approvals)
    .where(and(eq(schema.approvals.status, 'pending'), isNotNull(schema.approvals.expiresAt), lte(schema.approvals.expiresAt, now))).limit(200)
  for (const o of overdue) if (await expireApproval(o.id, now)) expired++

  const candidates = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.status, 'pending'), isNotNull(schema.approvals.nextReminderAt), lte(schema.approvals.nextReminderAt, now))).limit(200)
  for (const a of candidates) {
    if (!isReminderDue(a, now) || !a.reminderIntervalHours) continue
    const [claimed] = await db.update(schema.approvals)
      .set({ nextReminderAt: nextReminderAfter(now, a.reminderIntervalHours), remindersSent: sql`${schema.approvals.remindersSent} + 1` })
      .where(and(eq(schema.approvals.id, a.id), eq(schema.approvals.status, 'pending'), eq(schema.approvals.nextReminderAt, a.nextReminderAt!)))
      .returning({ id: schema.approvals.id })
    if (!claimed) continue
    const approvers = (await db.select({ u: schema.approvalApprovers.userId }).from(schema.approvalApprovers).where(eq(schema.approvalApprovers.approvalId, a.id))).map((r) => r.u)
    const decided = (await db.select({ d: schema.approvalDecisions.approverId, decision: schema.approvalDecisions.decision }).from(schema.approvalDecisions).where(eq(schema.approvalDecisions.approvalId, a.id)))
    const waiting = pendingApprovers(approvers, decided.map((d) => ({ approverId: d.d, decision: d.decision as 'approved' | 'declined' })))
    if (waiting.length === 0) continue
    await notifyRequested(a.id, true, waiting)
    reminded++
  }
  return { expired, reminded }
}
