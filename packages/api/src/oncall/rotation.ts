/**
 * On-call rotation maths, pure and unit tested. Members take turns in shifts of `rotationHours`, beginning with
 * the first member at `startAt`. An override replaces whoever the rotation says for its window; where overrides
 * overlap, the one that started last wins. Before `startAt` nobody is on call.
 */
export interface Rotation { memberIds: number[]; startAt: Date; rotationHours: number }
export interface Override { id?: number; userId: number; startsAt: Date; endsAt: Date }
export interface Shift { userId: number; from: Date; to: Date; override: boolean }

const HOUR = 3_600_000;

export function rotationUserAt(r: Rotation, at: Date): number | null {
  if (!r.memberIds.length || r.rotationHours < 1 || at < r.startAt) return null;
  const idx = Math.floor((at.getTime() - r.startAt.getTime()) / (r.rotationHours * HOUR));
  return r.memberIds[idx % r.memberIds.length];
}

export function onCallAt(r: Rotation, overrides: Override[], at: Date): { userId: number; override: boolean } | null {
  const active = overrides.filter((o) => o.startsAt <= at && at < o.endsAt).sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  if (active.length) return { userId: active[0].userId, override: true };
  const u = rotationUserAt(r, at);
  return u === null ? null : { userId: u, override: false };
}

/** Consecutive shifts in [from, to), with overrides cut in; adjacent pieces of the same person and kind are merged. */
export function shiftsBetween(r: Rotation, overrides: Override[], from: Date, to: Date, maxShifts = 500): Shift[] {
  if (!r.memberIds.length || r.rotationHours < 1 || to <= from) return [];
  const cuts = new Set<number>([from.getTime(), to.getTime()]);
  const step = r.rotationHours * HOUR;
  const first = Math.max(0, Math.floor((from.getTime() - r.startAt.getTime()) / step));
  for (let t = r.startAt.getTime() + first * step; t < to.getTime() && cuts.size < maxShifts * 2; t += step) if (t > from.getTime()) cuts.add(t);
  for (const o of overrides) for (const t of [o.startsAt.getTime(), o.endsAt.getTime()]) if (t > from.getTime() && t < to.getTime()) cuts.add(t);
  const points = [...cuts].sort((a, b) => a - b);
  const out: Shift[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = new Date(points[i]);
    const who = onCallAt(r, overrides, a);
    if (!who) continue;
    const last = out[out.length - 1];
    if (last && last.userId === who.userId && last.override === who.override && last.to.getTime() === points[i]) last.to = new Date(points[i + 1]);
    else out.push({ userId: who.userId, from: a, to: new Date(points[i + 1]), override: who.override });
    if (out.length >= maxShifts) break;
  }
  return out;
}

/** The person after `userId` in the rotation order (wraps around); null when the rotation has nobody else. */
export function nextInRotation(memberIds: number[], userId: number | null): number | null {
  if (memberIds.length < 2) return null;
  const i = userId === null ? -1 : memberIds.indexOf(userId);
  return memberIds[(i + 1) % memberIds.length];
}
