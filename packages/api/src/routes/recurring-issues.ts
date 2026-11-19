/**
 * Recurring issues of a project (PROJECT_ADMIN): rules that create an issue from a template on a schedule.
 * The scheduler itself lives in recurring/service.ts and is started from index.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requirePermission } from '../middleware/permissions';
import { nextOccurrence, validateRule } from '../recurring/schedule';
import { ruleToSchedule, type RuleRow } from '../recurring/service';

const app = new Hono<AppContext>();
app.use('/rest/api/2/project/*/recurring-issue*', sessionMiddleware);

const base = {
  name: z.string().trim().min(1).max(100),
  templateId: z.number().int().positive(),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  timezone: z.string().min(1).max(64).default('UTC'),
  ownerId: z.number().int().positive().optional(),
  active: z.boolean().default(true),
};
const createBody = z.object(base).strict();
const updateBody = z.object(base).partial().strict();

const zerr = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);

async function projectByKey(key: string) {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
  return p;
}

function serialize(r: RuleRow, extra: { templateName?: string | null; ownerName?: string | null } = {}) {
  return {
    id: r.id, name: r.name, templateId: r.templateId, templateName: extra.templateName ?? null, frequency: r.frequency, daysOfWeek: r.daysOfWeek,
    dayOfMonth: r.dayOfMonth, timeOfDay: r.timeOfDay, timezone: r.timezone, ownerId: r.ownerId, ownerName: extra.ownerName ?? null,
    active: r.active, lastRunAt: r.lastRunAt, nextRunAt: r.active ? r.nextRunAt : null, createdAt: r.createdAt,
  };
}

/** The template must be this project's or a global one. */
async function usableTemplate(projectId: number, templateId: number) {
  const [t] = await db.select().from(schema.issueTemplates)
    .where(and(eq(schema.issueTemplates.id, templateId), or(isNull(schema.issueTemplates.projectId), eq(schema.issueTemplates.projectId, projectId)))).limit(1);
  return t;
}

app.get('/rest/api/2/project/:key/recurring-issue', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  const rows = await db.select({ r: schema.recurringIssues, templateName: schema.issueTemplates.name, ownerName: schema.users.displayName })
    .from(schema.recurringIssues)
    .innerJoin(schema.issueTemplates, eq(schema.issueTemplates.id, schema.recurringIssues.templateId))
    .innerJoin(schema.users, eq(schema.users.id, schema.recurringIssues.ownerId))
    .where(eq(schema.recurringIssues.projectId, p.id)).orderBy(schema.recurringIssues.name);
  return c.json({ archived: !!p.archivedAt, rules: rows.map((x) => serialize(x.r, x)) });
});

app.post('/rest/api/2/project/:key/recurring-issue', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const user = c.get('user')!;
  const p = await projectByKey(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ errorMessages: zerr(parsed.error) }, 400);
  const b = parsed.data;
  const err = validateRule({ frequency: b.frequency, daysOfWeek: b.daysOfWeek, dayOfMonth: b.dayOfMonth, timeOfDay: b.timeOfDay, timezone: b.timezone });
  if (err) return c.json({ errorMessages: [err] }, 400);
  if (!(await usableTemplate(p.id, b.templateId))) return c.json({ errorMessages: ['Unknown template (use a template of this project or a global one)'] }, 400);
  const ownerId = b.ownerId ?? user.id;
  const [owner] = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, ownerId), eq(schema.users.active, true))).limit(1);
  if (!owner) return c.json({ errorMessages: ['Unknown or inactive owner'] }, 400);
  const next = b.active ? nextOccurrence({ frequency: b.frequency, daysOfWeek: b.daysOfWeek, dayOfMonth: b.dayOfMonth, timeOfDay: b.timeOfDay, timezone: b.timezone }, new Date()) : null;
  const [row] = await db.insert(schema.recurringIssues).values({
    projectId: p.id, templateId: b.templateId, name: b.name, frequency: b.frequency, daysOfWeek: b.daysOfWeek, dayOfMonth: b.frequency === 'monthly' ? b.dayOfMonth ?? null : null,
    timeOfDay: b.timeOfDay, timezone: b.timezone, ownerId, active: b.active, nextRunAt: next,
  }).returning();
  return c.json(serialize(row), 201);
});

app.put('/rest/api/2/project/:key/recurring-issue/:id', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  const [cur] = await db.select().from(schema.recurringIssues).where(and(eq(schema.recurringIssues.id, Number(c.req.param('id'))), eq(schema.recurringIssues.projectId, p.id))).limit(1);
  if (!cur) return c.json({ errorMessages: ['Recurring issue not found'] }, 404);
  const parsed = updateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ errorMessages: zerr(parsed.error) }, 400);
  const b = parsed.data;
  const merged = {
    frequency: b.frequency ?? cur.frequency, daysOfWeek: b.daysOfWeek ?? cur.daysOfWeek, dayOfMonth: b.dayOfMonth !== undefined ? b.dayOfMonth : cur.dayOfMonth,
    timeOfDay: b.timeOfDay ?? cur.timeOfDay, timezone: b.timezone ?? cur.timezone,
  };
  const err = validateRule(merged as any);
  if (err) return c.json({ errorMessages: [err] }, 400);
  if (b.templateId !== undefined && !(await usableTemplate(p.id, b.templateId))) return c.json({ errorMessages: ['Unknown template (use a template of this project or a global one)'] }, 400);
  if (b.ownerId !== undefined) {
    const [owner] = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, b.ownerId), eq(schema.users.active, true))).limit(1);
    if (!owner) return c.json({ errorMessages: ['Unknown or inactive owner'] }, 400);
  }
  const active = b.active ?? cur.active;
  const scheduleChanged = ['frequency', 'daysOfWeek', 'dayOfMonth', 'timeOfDay', 'timezone'].some((k) => (b as any)[k] !== undefined);
  const set: Partial<typeof schema.recurringIssues.$inferInsert> = { updatedAt: new Date() };
  if (b.name !== undefined) set.name = b.name;
  if (b.templateId !== undefined) set.templateId = b.templateId;
  if (b.ownerId !== undefined) set.ownerId = b.ownerId;
  if (b.active !== undefined) set.active = b.active;
  if (scheduleChanged) {
    set.frequency = merged.frequency; set.daysOfWeek = merged.daysOfWeek; set.timeOfDay = merged.timeOfDay; set.timezone = merged.timezone;
    set.dayOfMonth = merged.frequency === 'monthly' ? merged.dayOfMonth ?? null : null;
  }
  // Resuming or re-scheduling starts from now: slots that passed while paused are not made up.
  if (scheduleChanged || (b.active === true && !cur.active)) set.nextRunAt = active ? nextOccurrence(ruleToSchedule({ ...merged, frequency: merged.frequency, daysOfWeek: merged.daysOfWeek } as any), new Date()) : null;
  if (b.active === false) set.nextRunAt = null;
  const [row] = await db.update(schema.recurringIssues).set(set).where(eq(schema.recurringIssues.id, cur.id)).returning();
  return c.json(serialize(row));
});

app.delete('/rest/api/2/project/:key/recurring-issue/:id', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  const gone = await db.delete(schema.recurringIssues).where(and(eq(schema.recurringIssues.id, Number(c.req.param('id'))), eq(schema.recurringIssues.projectId, p.id))).returning({ id: schema.recurringIssues.id });
  if (!gone.length) return c.json({ errorMessages: ['Recurring issue not found'] }, 404);
  return c.json({});
});

app.get('/rest/api/2/project/:key/recurring-issue/:id/runs', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  const id = Number(c.req.param('id'));
  const [rule] = await db.select({ id: schema.recurringIssues.id }).from(schema.recurringIssues).where(and(eq(schema.recurringIssues.id, id), eq(schema.recurringIssues.projectId, p.id))).limit(1);
  if (!rule) return c.json({ errorMessages: ['Recurring issue not found'] }, 404);
  const runs = await db.select().from(schema.recurringIssueRuns).where(eq(schema.recurringIssueRuns.recurringId, id)).orderBy(desc(schema.recurringIssueRuns.slotAt)).limit(50);
  return c.json({ runs: runs.map((r) => ({ id: r.id, slotAt: r.slotAt, status: r.status, issueKey: r.issueKey, error: r.error, createdAt: r.createdAt })) });
});

export default app;
