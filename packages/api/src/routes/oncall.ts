import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { onCallAt, shiftsBetween, type Rotation } from '../oncall/rotation';

/**
 * On-call schedules. Any signed-in user can see who is on call (people need to know whom to ask); creating
 * schedules, changing the rotation and adding overrides is for SYSTEM_ADMIN.
 */
const app = new Hono<AppContext>();
const P = '/rest/api/2/oncall/schedule';
const admin = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const;
const nf = (c: any, what = 'Schedule') => c.json({ errorMessages: [`${what} not found`] }, 404);

const body = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  rotationHours: z.number().int().min(1).max(24 * 90),
  startAt: z.string().datetime(),
  memberIds: z.array(z.number().int().positive()).max(100),
  /** Escalate alerts not acknowledged within this many minutes; null = never */
  escalationMinutes: z.number().int().min(1).max(60 * 24).nullable().optional(),
  escalationScheduleId: z.number().int().positive().nullable().optional(),
});

async function load(id: number) {
  const [s] = await db.select().from(schema.oncallSchedules).where(eq(schema.oncallSchedules.id, id)).limit(1);
  if (!s) return null;
  const members = await db.select().from(schema.oncallMembers).where(eq(schema.oncallMembers.scheduleId, id)).orderBy(asc(schema.oncallMembers.position));
  const overrides = await db.select().from(schema.oncallOverrides).where(eq(schema.oncallOverrides.scheduleId, id)).orderBy(asc(schema.oncallOverrides.startsAt));
  const rotation: Rotation = { memberIds: members.map((m) => m.userId), startAt: s.startAt, rotationHours: s.rotationHours };
  return { s, members, overrides, rotation };
}

async function names(ids: number[]) {
  const uniq = [...new Set(ids)];
  const rows = uniq.length ? await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, uniq)) : [];
  return new Map(rows.map((r) => [r.id, r.displayName]));
}

async function view(id: number) {
  const l = await load(id);
  if (!l) return null;
  const now = new Date();
  const who = onCallAt(l.rotation, l.overrides, now);
  const nm = await names([...l.rotation.memberIds, ...l.overrides.map((o) => o.userId), ...(who ? [who.userId] : [])]);
  const user = (uid: number) => ({ id: uid, displayName: nm.get(uid) ?? 'Unknown' });
  return {
    id: l.s.id, name: l.s.name, description: l.s.description, rotationHours: l.s.rotationHours, startAt: l.s.startAt.toISOString(),
    escalationMinutes: l.s.escalationMinutes, escalationScheduleId: l.s.escalationScheduleId, hasAlertKey: !!l.s.integrationKeyHash,
    members: l.rotation.memberIds.map(user),
    onCall: who ? { ...user(who.userId), override: who.override } : null,
    overrides: l.overrides.filter((o) => o.endsAt > now).map((o) => ({ id: o.id, user: user(o.userId), startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString() })),
  };
}

async function checkMembers(ids: number[]): Promise<string | null> {
  const uniq = [...new Set(ids)];
  if (uniq.length !== ids.length) return 'A person can be in the rotation only once';
  if (!uniq.length) return null;
  const found = await db.select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, uniq), eq(schema.users.active, true)));
  return found.length === uniq.length ? null : 'Unknown or inactive user in the rotation';
}

async function checkEscalation(target: number | null | undefined, self: number | null): Promise<string | null> {
  if (!target) return null;
  if (target === self) return 'A schedule cannot escalate to itself';
  const [t] = await db.select({ id: schema.oncallSchedules.id }).from(schema.oncallSchedules).where(eq(schema.oncallSchedules.id, target)).limit(1);
  return t ? null : 'Escalation schedule not found';
}

app.get(P, requireAuth, async (c) => {
  const rows = await db.select({ id: schema.oncallSchedules.id }).from(schema.oncallSchedules).orderBy(asc(schema.oncallSchedules.name));
  return c.json({ schedules: (await Promise.all(rows.map((r) => view(r.id)))).filter(Boolean) });
});

app.get(`${P}/:id`, requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const v = Number.isInteger(id) ? await view(id) : null;
  return v ? c.json(v) : nf(c);
});

/** Shifts in a window (default: the next 30 days), overrides cut in. */
app.get(`${P}/:id/shifts`, requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const l = Number.isInteger(id) ? await load(id) : null;
  if (!l) return nf(c);
  const from = c.req.query('from') ? new Date(c.req.query('from')!) : new Date();
  const to = c.req.query('to') ? new Date(c.req.query('to')!) : new Date(from.getTime() + 30 * 86_400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return c.json({ errorMessages: ['from and to must be ISO dates'] }, 400);
  if (to.getTime() - from.getTime() > 366 * 86_400_000) return c.json({ errorMessages: ['The window can be at most one year'] }, 400);
  const shifts = shiftsBetween(l.rotation, l.overrides, from, to);
  const nm = await names(shifts.map((s) => s.userId));
  return c.json({ shifts: shifts.map((s) => ({ user: { id: s.userId, displayName: nm.get(s.userId) ?? 'Unknown' }, from: s.from.toISOString(), to: s.to.toISOString(), override: s.override })) });
});

app.post(P, ...admin, zValidator('json', body), async (c) => {
  const b = c.req.valid('json');
  const bad = await checkMembers(b.memberIds);
  if (bad) return c.json({ errorMessages: [bad] }, 400);
  const esc = await checkEscalation(b.escalationScheduleId, null);
  if (esc) return c.json({ errorMessages: [esc] }, 400);
  const [s] = await db.insert(schema.oncallSchedules).values({ name: b.name, description: b.description ?? null, rotationHours: b.rotationHours, startAt: new Date(b.startAt), escalationMinutes: b.escalationMinutes ?? null, escalationScheduleId: b.escalationScheduleId ?? null }).returning();
  if (b.memberIds.length) await db.insert(schema.oncallMembers).values(b.memberIds.map((userId, position) => ({ scheduleId: s.id, userId, position })));
  return c.json(await view(s.id), 201);
});

app.put(`${P}/:id`, ...admin, zValidator('json', body), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || !(await load(id))) return nf(c);
  const b = c.req.valid('json');
  const bad = await checkMembers(b.memberIds);
  if (bad) return c.json({ errorMessages: [bad] }, 400);
  const esc = await checkEscalation(b.escalationScheduleId, id);
  if (esc) return c.json({ errorMessages: [esc] }, 400);
  await db.transaction(async (tx) => {
    await tx.update(schema.oncallSchedules).set({ name: b.name, description: b.description ?? null, rotationHours: b.rotationHours, startAt: new Date(b.startAt), escalationMinutes: b.escalationMinutes ?? null, escalationScheduleId: b.escalationScheduleId ?? null }).where(eq(schema.oncallSchedules.id, id));
    await tx.delete(schema.oncallMembers).where(eq(schema.oncallMembers.scheduleId, id));
    if (b.memberIds.length) await tx.insert(schema.oncallMembers).values(b.memberIds.map((userId, position) => ({ scheduleId: id, userId, position })));
  });
  return c.json(await view(id));
});

app.delete(`${P}/:id`, ...admin, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || !(await load(id))) return nf(c);
  await db.update(schema.oncallSchedules).set({ escalationScheduleId: null }).where(eq(schema.oncallSchedules.escalationScheduleId, id));
  await db.delete(schema.oncallSchedules).where(eq(schema.oncallSchedules.id, id));
  return c.body(null, 204);
});

app.post(`${P}/:id/override`, ...admin, zValidator('json', z.object({ userId: z.number().int().positive(), startsAt: z.string().datetime(), endsAt: z.string().datetime() })), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || !(await load(id))) return nf(c);
  const b = c.req.valid('json');
  if (new Date(b.endsAt) <= new Date(b.startsAt)) return c.json({ errorMessages: ['The override must end after it starts'] }, 400);
  const bad = await checkMembers([b.userId]);
  if (bad) return c.json({ errorMessages: [bad] }, 400);
  await db.insert(schema.oncallOverrides).values({ scheduleId: id, userId: b.userId, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt), createdBy: c.get('user')!.id });
  return c.json(await view(id), 201);
});

app.delete(`${P}/:id/override/:overrideId`, ...admin, async (c) => {
  const id = Number(c.req.param('id')); const oid = Number(c.req.param('overrideId'));
  if (!Number.isInteger(id) || !Number.isInteger(oid)) return nf(c, 'Override');
  const del = await db.delete(schema.oncallOverrides).where(and(eq(schema.oncallOverrides.id, oid), eq(schema.oncallOverrides.scheduleId, id))).returning({ id: schema.oncallOverrides.id });
  return del.length ? c.body(null, 204) : nf(c, 'Override');
});

export default app;
