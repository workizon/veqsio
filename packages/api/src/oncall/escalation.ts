import { and, eq, isNull, isNotNull, or, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { nextInRotation, onCallAt, type Rotation } from './rotation';
import { sendPush } from '../services/push';

async function rotationOf(scheduleId: number): Promise<{ rotation: Rotation; overrides: (typeof schema.oncallOverrides.$inferSelect)[] } | null> {
  const [s] = await db.select().from(schema.oncallSchedules).where(eq(schema.oncallSchedules.id, scheduleId)).limit(1);
  if (!s) return null;
  const members = await db.select().from(schema.oncallMembers).where(eq(schema.oncallMembers.scheduleId, scheduleId)).orderBy(schema.oncallMembers.position);
  const overrides = await db.select().from(schema.oncallOverrides).where(eq(schema.oncallOverrides.scheduleId, scheduleId));
  return { rotation: { memberIds: members.map((m) => m.userId), startAt: s.startAt, rotationHours: s.rotationHours }, overrides };
}

/**
 * Escalates alerts nobody acknowledged in time: pushes to whoever is on call in the escalation schedule, or, with
 * none configured (or nobody on call there), to the next person in the alert's own rotation. Snoozed alerts wait.
 * Each alert is escalated once. Returns how many alerts were escalated.
 */
export async function runOncallEscalation(now = new Date()): Promise<number> {
  const due = await db.select({ a: schema.oncallAlerts, s: schema.oncallSchedules }).from(schema.oncallAlerts)
    .innerJoin(schema.oncallSchedules, eq(schema.oncallSchedules.id, schema.oncallAlerts.scheduleId))
    .where(and(
      eq(schema.oncallAlerts.status, 'open'),
      isNull(schema.oncallAlerts.escalatedAt),
      isNotNull(schema.oncallSchedules.escalationMinutes),
      or(isNull(schema.oncallAlerts.snoozedUntil), lte(schema.oncallAlerts.snoozedUntil, now)),
      sql`${schema.oncallAlerts.firstSeenAt} + make_interval(mins => ${schema.oncallSchedules.escalationMinutes}) <= ${now.toISOString()}::timestamptz`,
    )).limit(100);
  let n = 0;
  for (const { a, s } of due) {
    let target: number | null = null;
    if (s.escalationScheduleId) {
      const e = await rotationOf(s.escalationScheduleId);
      target = e ? (onCallAt(e.rotation, e.overrides, now)?.userId ?? null) : null;
    }
    if (target === null) {
      const own = await rotationOf(s.id);
      if (own) target = nextInRotation(own.rotation.memberIds, a.notifiedUserId);
    }
    // claim the alert first so two nodes never escalate it twice
    const claimed = await db.update(schema.oncallAlerts).set({ escalatedAt: now, escalatedUserId: target })
      .where(and(eq(schema.oncallAlerts.id, a.id), isNull(schema.oncallAlerts.escalatedAt))).returning({ id: schema.oncallAlerts.id });
    if (!claimed.length) continue;
    n++;
    if (target !== null) await sendPush([target], { title: `[ESCALATED] ${a.title}`, body: `Not acknowledged after ${s.escalationMinutes} min on ${s.name}`, url: '/admin/oncall', tag: `alert-${a.id}-esc`, kind: 'oncall' });
  }
  return n;
}
