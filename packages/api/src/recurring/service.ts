/**
 * Recurring issues: the scheduler tick.
 *
 * Idempotence: every scheduled slot gets exactly one row in recurring_issue_runs (unique on rule + slot) BEFORE
 * anything is created. Whoever inserts the row owns the slot; a restart, a second tick or a second API instance
 * hits the unique index and does nothing. The consequence is at-most-once: if the process dies between inserting
 * the row and creating the issue, that slot stays 'pending' and is never retried (a duplicate is worse than a
 * missed slot, and the run log shows the stuck slot). Failures are recorded as 'failed' with the reason.
 *
 * Catch-up: after downtime only the latest due slot creates an issue; the earlier ones are logged as 'skipped'.
 * Rules of archived projects never create issues; their due slots are logged as 'skipped' and the rule moves on.
 */
import { and, eq, lte } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { nextOccurrence, type ScheduleRule } from './schedule';
import { buildCreateRequest } from '../templates/service';
import { createIssue } from '../issues/service';
import { checkProjectPermission } from '../middleware/permissions';
import { invalidateIssueCache } from '../middleware/cache';
import { publishIssue } from '../realtime/publish';
import { notifyIssueCreated } from '../services/notifications';

export type RuleRow = typeof schema.recurringIssues.$inferSelect;

export const ruleToSchedule = (r: Pick<RuleRow, 'frequency' | 'daysOfWeek' | 'dayOfMonth' | 'timeOfDay' | 'timezone'>): ScheduleRule => ({
  frequency: r.frequency as ScheduleRule['frequency'], daysOfWeek: r.daysOfWeek, dayOfMonth: r.dayOfMonth, timeOfDay: r.timeOfDay, timezone: r.timezone,
});

const MAX_SLOTS_PER_TICK = 400;

async function runSlot(rule: RuleRow, project: { id: number; projectKey: string; archivedAt: Date | null }, slot: Date, skipReason: string | null): Promise<'created' | 'skipped' | 'failed' | 'duplicate'> {
  const [run] = await db.insert(schema.recurringIssueRuns).values({ recurringId: rule.id, slotAt: slot, status: skipReason ? 'skipped' : 'pending', error: skipReason })
    .onConflictDoNothing().returning({ id: schema.recurringIssueRuns.id });
  if (!run) return 'duplicate';
  if (skipReason) return 'skipped';
  const fail = async (msg: string) => { await db.update(schema.recurringIssueRuns).set({ status: 'failed', error: msg.slice(0, 1000) }).where(eq(schema.recurringIssueRuns.id, run.id)); return 'failed' as const; };
  try {
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, rule.ownerId)).limit(1);
    if (!owner || !owner.active) return await fail('The owner of the rule is not an active user');
    if (!(await checkProjectPermission(owner, project.id, 'CREATE_ISSUES'))) return await fail('The owner of the rule may not create issues in this project');
    const [tpl] = await db.select().from(schema.issueTemplates).where(eq(schema.issueTemplates.id, rule.templateId)).limit(1);
    if (!tpl) return await fail('The template no longer exists');
    const req = await buildCreateRequest(tpl, project, { at: slot, timezone: rule.timezone });
    const issue = await createIssue(req, owner.id);
    await db.update(schema.recurringIssueRuns).set({ status: 'created', issueId: issue.id, issueKey: issue.key }).where(eq(schema.recurringIssueRuns.id, run.id));
    await invalidateIssueCache().catch(() => {});
    try { publishIssue('issue.created', issue, owner.id); await notifyIssueCreated(issue); } catch (e) { console.error('[recurring] notification failed:', (e as Error).message); }
    return 'created';
  } catch (e) {
    return fail((e as Error).message || 'Failed to create the issue');
  }
}

/** Processes every rule whose next slot has passed. Safe to call concurrently and repeatedly. */
export async function runDueRecurring(now: Date = new Date()): Promise<{ created: number; skipped: number; failed: number }> {
  const due = await db.select({ rule: schema.recurringIssues, project: { id: schema.projects.id, projectKey: schema.projects.projectKey, archivedAt: schema.projects.archivedAt } })
    .from(schema.recurringIssues).innerJoin(schema.projects, eq(schema.projects.id, schema.recurringIssues.projectId))
    .where(and(eq(schema.recurringIssues.active, true), lte(schema.recurringIssues.nextRunAt, now))).limit(200);
  const tally = { created: 0, skipped: 0, failed: 0 };
  for (const { rule, project } of due) {
    let slot: Date | null = rule.nextRunAt;
    const schedule = ruleToSchedule(rule);
    for (let i = 0; slot && slot <= now && i < MAX_SLOTS_PER_TICK; i++) {
      const next: Date | null = nextOccurrence(schedule, slot);
      const laterDue = next !== null && next <= now;
      const reason = project.archivedAt ? 'Project is archived' : laterDue ? 'Missed while the server was not running; only the latest missed slot is created' : null;
      const outcome = await runSlot(rule, project, slot, reason);
      if (outcome === 'created') tally.created++; else if (outcome === 'skipped') tally.skipped++; else if (outcome === 'failed') tally.failed++;
      // Optimistic advance: when another instance already moved the rule, stop.
      const moved = await db.update(schema.recurringIssues).set({ lastRunAt: slot, nextRunAt: next, updatedAt: new Date() })
        .where(and(eq(schema.recurringIssues.id, rule.id), eq(schema.recurringIssues.nextRunAt, slot))).returning({ id: schema.recurringIssues.id });
      if (!moved.length) break;
      slot = next;
    }
  }
  return tally;
}
