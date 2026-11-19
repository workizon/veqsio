import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { hasGlobalPermission } from '../rbac/service';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { hashAlertKey, newAlertKey, parseAlert } from '../oncall/alerts';
import { onCallAt } from '../oncall/rotation';
import { sendPush } from '../services/push';

/**
 * Alert ingestion for on-call schedules. Monitoring tools post to /rest/api/2/oncall/alert with the schedule's
 * integration key (header x-veqsio-alert-key); the key is shown once and only its hash is stored. Alerts with the
 * same dedup key are counted instead of duplicated, a "resolved" post closes them, and the person on call is
 * notified by push when a new alert opens. Acknowledge / snooze / close need the schedule's members or an admin.
 */
const app = new Hono<AppContext>();
const P = '/rest/api/2/oncall';
const admin = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const;

app.post(`${P}/schedule/:id/key`, ...admin, async (c) => {
  const id = Number(c.req.param('id'));
  const [s] = Number.isInteger(id) ? await db.select({ id: schema.oncallSchedules.id }).from(schema.oncallSchedules).where(eq(schema.oncallSchedules.id, id)).limit(1) : [];
  if (!s) return c.json({ errorMessages: ['Schedule not found'] }, 404);
  const key = newAlertKey();
  await db.update(schema.oncallSchedules).set({ integrationKeyHash: hashAlertKey(key) }).where(eq(schema.oncallSchedules.id, id));
  return c.json({ key, note: 'Shown once. Send it as the x-veqsio-alert-key header. Creating a new key replaces the old one.' });
});

app.delete(`${P}/schedule/:id/key`, ...admin, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ errorMessages: ['Schedule not found'] }, 404);
  await db.update(schema.oncallSchedules).set({ integrationKeyHash: null }).where(eq(schema.oncallSchedules.id, id));
  return c.body(null, 204);
});

app.post(`${P}/alert`, async (c) => {
  const key = c.req.header('x-veqsio-alert-key') ?? '';
  const [sch] = key ? await db.select().from(schema.oncallSchedules).where(eq(schema.oncallSchedules.integrationKeyHash, hashAlertKey(key))).limit(1) : [];
  if (!sch) return c.json({ errorMessages: ['Unauthorized'] }, 401);
  const raw = await c.req.text();
  if (raw.length > 100_000) return c.json({ errorMessages: ['The alert is too large'] }, 413);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return c.json({ errorMessages: ['The body must be JSON'] }, 400); }
  const a = parseAlert(json);
  if (typeof a === 'string') return c.json({ errorMessages: [a] }, 400);

  const [open] = await db.select().from(schema.oncallAlerts)
    .where(and(eq(schema.oncallAlerts.scheduleId, sch.id), eq(schema.oncallAlerts.dedupKey, a.dedupKey), sql`${schema.oncallAlerts.status} <> 'closed'`)).limit(1);

  if (a.resolved) {
    if (!open) return c.json({ status: 'ignored' });
    await db.update(schema.oncallAlerts).set({ status: 'closed', closedAt: new Date(), lastSeenAt: new Date() }).where(eq(schema.oncallAlerts.id, open.id));
    return c.json({ id: open.id, status: 'closed' });
  }
  if (open) {
    await db.update(schema.oncallAlerts).set({ count: sql`${schema.oncallAlerts.count} + 1`, lastSeenAt: new Date() }).where(eq(schema.oncallAlerts.id, open.id));
    return c.json({ id: open.id, status: open.status, deduplicated: true });
  }

  const members = await db.select().from(schema.oncallMembers).where(eq(schema.oncallMembers.scheduleId, sch.id)).orderBy(schema.oncallMembers.position);
  const overrides = await db.select().from(schema.oncallOverrides).where(eq(schema.oncallOverrides.scheduleId, sch.id));
  const who = onCallAt({ memberIds: members.map((m) => m.userId), startAt: sch.startAt, rotationHours: sch.rotationHours }, overrides, new Date());
  let created;
  try {
    [created] = await db.insert(schema.oncallAlerts).values({ scheduleId: sch.id, dedupKey: a.dedupKey, title: a.title, description: a.description, severity: a.severity, notifiedUserId: who?.userId ?? null }).returning();
  } catch {
    // two identical alerts arrived at once: the other insert won, count this one on it
    await db.update(schema.oncallAlerts).set({ count: sql`${schema.oncallAlerts.count} + 1`, lastSeenAt: new Date() })
      .where(and(eq(schema.oncallAlerts.scheduleId, sch.id), eq(schema.oncallAlerts.dedupKey, a.dedupKey), sql`${schema.oncallAlerts.status} <> 'closed'`));
    return c.json({ status: 'open', deduplicated: true });
  }
  if (who) await sendPush([who.userId], { title: `[${a.severity.toUpperCase()}] ${a.title}`, body: a.description ?? `Alert on ${sch.name}`, url: '/admin/oncall', tag: `alert-${created.id}`, kind: 'oncall' });
  return c.json({ id: created.id, status: 'open', notified: who?.userId ?? null }, 201);
});

async function mayAct(userId: number, scheduleId: number, isAdmin: boolean) {
  if (isAdmin) return true;
  const [m] = await db.select({ u: schema.oncallMembers.userId }).from(schema.oncallMembers).where(and(eq(schema.oncallMembers.scheduleId, scheduleId), eq(schema.oncallMembers.userId, userId))).limit(1);
  return !!m;
}

app.get(`${P}/alert`, requireAuth, async (c) => {
  const status = c.req.query('status');
  const sid = Number(c.req.query('scheduleId'));
  const conds = [] as any[];
  if (status && ['open', 'acknowledged', 'closed'].includes(status)) conds.push(eq(schema.oncallAlerts.status, status));
  else if (status === 'active') conds.push(inArray(schema.oncallAlerts.status, ['open', 'acknowledged']));
  if (Number.isInteger(sid) && sid > 0) conds.push(eq(schema.oncallAlerts.scheduleId, sid));
  const rows = await db.select().from(schema.oncallAlerts).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.oncallAlerts.lastSeenAt)).limit(200);
  return c.json({ alerts: rows });
});

const act = (action: 'acknowledge' | 'close' | 'snooze') =>
  app.post(`${P}/alert/:id/${action}`, requireAuth, zValidator('json', z.object({ minutes: z.number().int().min(1).max(60 * 24 * 7).optional() }).default({})), async (c) => {
    const id = Number(c.req.param('id'));
    const [al] = Number.isInteger(id) ? await db.select().from(schema.oncallAlerts).where(eq(schema.oncallAlerts.id, id)).limit(1) : [];
    if (!al) return c.json({ errorMessages: ['Alert not found'] }, 404);
    const user = c.get('user')!;
    const isAdmin = await hasGlobalPermission(user.id, 'SYSTEM_ADMIN');
    if (!(await mayAct(user.id, al.scheduleId, isAdmin))) return c.json({ errorMessages: ['Only people on this schedule or administrators can do that'] }, 403);
    if (al.status === 'closed') return c.json({ errorMessages: ['The alert is already closed'] }, 409);
    const now = new Date();
    if (action === 'acknowledge') await db.update(schema.oncallAlerts).set({ status: 'acknowledged', acknowledgedBy: user.id, acknowledgedAt: now }).where(eq(schema.oncallAlerts.id, id));
    else if (action === 'close') await db.update(schema.oncallAlerts).set({ status: 'closed', closedAt: now }).where(eq(schema.oncallAlerts.id, id));
    else await db.update(schema.oncallAlerts).set({ snoozedUntil: new Date(now.getTime() + (c.req.valid('json').minutes ?? 60) * 60_000) }).where(eq(schema.oncallAlerts.id, id));
    const [out] = await db.select().from(schema.oncallAlerts).where(eq(schema.oncallAlerts.id, id)).limit(1);
    return c.json(out);
  });
act('acknowledge'); act('close'); act('snooze');

export default app;
