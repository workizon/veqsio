/** Pure due-time logic for filter subscriptions (all times UTC). */

export interface DueInput {
  schedule: string;
  hour: number;
  weekday: number | null;
  lastSentAt: Date | null;
  createdAt: Date;
}

/** Start of the most recent scheduled slot at or before `now`. */
export function currentPeriodStart(sub: Pick<DueInput, 'schedule' | 'hour' | 'weekday'>, now: Date): Date {
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), sub.hour, 0, 0, 0));
  if (sub.schedule === 'weekly') {
    const back = (now.getUTCDay() - (sub.weekday ?? 0) + 7) % 7;
    slot.setUTCDate(slot.getUTCDate() - back);
  }
  const step = sub.schedule === 'weekly' ? 7 : 1;
  if (slot.getTime() > now.getTime()) slot.setUTCDate(slot.getUTCDate() - step);
  return slot;
}

/**
 * A subscription is due when the latest scheduled slot has passed and nothing was sent (or the
 * subscription created) since that slot. A brand-new subscription waits for the next slot rather than
 * sending immediately; a missed slot is caught up once, never repeated.
 */
export function isSubscriptionDue(sub: DueInput, now: Date): boolean {
  if (sub.schedule !== 'daily' && sub.schedule !== 'weekly') return false;
  if (!Number.isInteger(sub.hour) || sub.hour < 0 || sub.hour > 23) return false;
  if (sub.schedule === 'weekly' && (sub.weekday === null || !Number.isInteger(sub.weekday) || sub.weekday < 0 || sub.weekday > 6)) return false;
  const start = currentPeriodStart(sub, now);
  const reference = sub.lastSentAt ?? sub.createdAt;
  return start.getTime() > reference.getTime();
}
