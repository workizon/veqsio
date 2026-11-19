import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, count, desc, eq, ilike, inArray, ne, or, type SQL } from 'drizzle-orm';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { MAX_JQL_LENGTH, validateJql } from '../jql/autocomplete';
import { getBrowsableProjectIds, isAdminUser } from '../services/browse';
import {
  canManageFilter, checkShareTargets, dedupeShares, getVisibleFilter, normalizeShares, sharesSchema, visibleToUserSql,
  type Share,
} from '../services/filter-access';

type User = typeof schema.users.$inferSelect;
type FilterRow = typeof schema.filters.$inferSelect;

/**
 * Saved filters. Visibility: owner, users/groups listed in `shares`, members who can browse a listed
 * project, everyone for a global share; administrators see everything. Anything the caller cannot see is
 * answered with 404 (never 403) so filter ids cannot be probed. Only the owner or an admin may modify,
 * delete or re-share a filter.
 */
const app = new Hono<AppContext>();
app.use('/rest/api/2/filter*', sessionMiddleware);

const notFound = (c: any) => c.json({ errorMessages: ['Filter not found'] }, 404);
const badRequest = (c: any, msg: string) => c.json({ errorMessages: [msg] }, 400);
const parseId = (c: any) => {
  const n = Number(c.req.param('id'));
  return Number.isInteger(n) ? n : -1;
};

const name = z.string().trim().min(1).max(255);
const jql = z.string().max(MAX_JQL_LENGTH);

const createBody = z.object({
  name,
  jql,
  favourite: z.boolean().optional(),
  shares: sharesSchema.optional(),
}).strict();

const updateBody = z.object({
  name: name.optional(),
  jql: jql.optional(),
  favourite: z.boolean().optional(),
  shares: sharesSchema.optional(),
}).strict();

const shareBody = z.object({ shares: sharesSchema }).strict();

async function readJson(c: any): Promise<unknown> {
  return c.req.json().catch(() => null);
}

function jqlError(value: string): string | null {
  const r = validateJql(value);
  return r.valid ? null : r.errors[0].message;
}

function present(f: FilterRow, ownerName: string | null, user: User, canManage: boolean) {
  const isOwner = f.authorId === user.id;
  return {
    id: String(f.id),
    name: f.name,
    jql: f.jql,
    favourite: isOwner ? !!f.favourite : false,
    owner: { id: f.authorId, displayName: ownerName },
    editable: canManage,
    ...(canManage ? { shares: normalizeShares(f.shares) } : {}),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

async function listFilters(user: User, extra: SQL[], opts: { all?: boolean; startAt?: number; maxResults?: number }) {
  const admin = await isAdminUser(user);
  const conds: SQL[] = [...extra];
  if (!(opts.all && admin)) conds.push(await visibleToUserSql(user));
  const where = conds.length ? and(...conds) : undefined;
  const base = db.select({ f: schema.filters, ownerName: schema.users.displayName })
    .from(schema.filters).leftJoin(schema.users, eq(schema.users.id, schema.filters.authorId));
  const rows = await (where ? base.where(where) : base)
    .orderBy(asc(schema.filters.name), desc(schema.filters.id))
    .limit(opts.maxResults ?? 100).offset(opts.startAt ?? 0);
  const [{ total }] = await (where
    ? db.select({ total: count() }).from(schema.filters).where(where)
    : db.select({ total: count() }).from(schema.filters));
  return { rows, total: Number(total), admin };
}

/* ------------------------------------------------------------------ */
/*  List / search                                                      */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/filter', requireAuth, async (c) => {
  const user = c.get('user')!;
  const all = c.req.query('all') === 'true';
  if (all && !(await isAdminUser(user))) return c.json({ errorMessages: ['Forbidden'] }, 403);
  const extra: SQL[] = [];
  if (c.req.query('favourites') === 'true') {
    extra.push(eq(schema.filters.favourite, true), eq(schema.filters.authorId, user.id));
  }
  const { rows, admin } = await listFilters(user, extra, { all, maxResults: 500 });
  return c.json(rows.map((r) => present(r.f, r.ownerName, user, r.f.authorId === user.id || admin)));
});

app.get('/rest/api/2/filter/favourite', requireAuth, async (c) => {
  const user = c.get('user')!;
  const filters = await db.select().from(schema.filters)
    .where(and(eq(schema.filters.authorId, user.id), eq(schema.filters.favourite, true)));
  return c.json(filters.map((f) => ({ id: String(f.id), name: f.name, jql: f.jql, favourite: true })));
});

app.get('/rest/api/2/filter/search', requireAuth, async (c) => {
  const user = c.get('user')!;
  const startAt = Math.max(0, Math.min(Number(c.req.query('startAt') ?? 0) || 0, 100_000));
  const maxResults = Math.max(1, Math.min(Number(c.req.query('maxResults') ?? 50) || 50, 100));
  const all = c.req.query('all') === 'true';
  if (all && !(await isAdminUser(user))) return c.json({ errorMessages: ['Forbidden'] }, 403);

  const extra: SQL[] = [];
  const nameQ = (c.req.query('name') || '').slice(0, 100);
  if (nameQ) extra.push(ilike(schema.filters.name, `%${nameQ.replace(/[\\%_]/g, (m) => `\\${m}`)}%`));
  const ownerQ = (c.req.query('owner') || '').slice(0, 100);
  if (ownerQ) {
    const like = `%${ownerQ.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const owners = await db.select({ id: schema.users.id }).from(schema.users)
      .where(or(ilike(schema.users.username, like), ilike(schema.users.displayName, like)))
      .limit(200);
    if (owners.length === 0) return c.json({ startAt, maxResults, total: 0, isLast: true, values: [] });
    extra.push(inArray(schema.filters.authorId, owners.map((o) => o.id)));
  }
  const shared = c.req.query('shared');
  if (shared === 'true') extra.push(ne(schema.filters.authorId, user.id)); // shared with me by others
  else if (shared === 'false') extra.push(eq(schema.filters.authorId, user.id)); // my own

  const { rows, total, admin } = await listFilters(user, extra, { all, startAt, maxResults });
  return c.json({
    startAt, maxResults, total, isLast: startAt + rows.length >= total,
    values: rows.map((r) => present(r.f, r.ownerName, user, r.f.authorId === user.id || admin)),
  });
});

/** Candidates for the share dialog: only things the caller may share with (no enumeration of hidden projects). */
app.get('/rest/api/2/filter/share-targets', requireAuth, async (c) => {
  const user = c.get('user')!;
  const type = c.req.query('type');
  const q = (c.req.query('q') || '').slice(0, 100);
  const like = `${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  if (type === 'user') {
    const rows = await db.select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
      .from(schema.users)
      .where(and(eq(schema.users.active, true), or(ilike(schema.users.username, like), ilike(schema.users.displayName, like))))
      .orderBy(asc(schema.users.displayName)).limit(20);
    return c.json({ values: rows.map((r) => ({ id: r.id, name: `${r.displayName} (${r.username})` })) });
  }
  if (type === 'group') {
    const admin = await isAdminUser(user);
    const base = db.select({ id: schema.groups.id, name: schema.groups.name }).from(schema.groups);
    const rows = admin
      ? await base.where(ilike(schema.groups.name, like)).orderBy(asc(schema.groups.name)).limit(20)
      : await base.innerJoin(schema.userGroups, eq(schema.userGroups.groupId, schema.groups.id))
        .where(and(eq(schema.userGroups.userId, user.id), ilike(schema.groups.name, like)))
        .orderBy(asc(schema.groups.name)).limit(20);
    return c.json({ values: rows.map((r: any) => ({ id: r.id ?? r.groups?.id, name: r.name ?? r.groups?.name })) });
  }
  if (type === 'project') {
    const ids = await getBrowsableProjectIds(user);
    if (ids.length === 0) return c.json({ values: [] });
    const rows = await db.select({ id: schema.projects.id, key: schema.projects.projectKey, name: schema.projects.name })
      .from(schema.projects)
      .where(and(inArray(schema.projects.id, ids), or(ilike(schema.projects.projectKey, like), ilike(schema.projects.name, like))))
      .orderBy(asc(schema.projects.projectKey)).limit(20);
    return c.json({ values: rows.map((r) => ({ id: r.id, name: `${r.name} (${r.key})` })) });
  }
  return badRequest(c, 'type must be user, group or project');
});

/* ------------------------------------------------------------------ */
/*  CRUD                                                               */
/* ------------------------------------------------------------------ */

app.post('/rest/api/2/filter', requireAuth, async (c) => {
  const user = c.get('user')!;
  const parsed = createBody.safeParse(await readJson(c));
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  const body = parsed.data;
  const err = jqlError(body.jql);
  if (err) return badRequest(c, `Invalid JQL: ${err}`);
  const shares = dedupeShares(body.shares ?? []);
  const shareErr = await checkShareTargets(user, shares);
  if (shareErr) return badRequest(c, shareErr);
  const [filter] = await db.insert(schema.filters).values({
    name: body.name, jql: body.jql, authorId: user.id, favourite: body.favourite ?? false, shares,
  }).returning();
  return c.json(present(filter, user.displayName, user, true), 201);
});

app.get('/rest/api/2/filter/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleFilter(user, parseId(c));
  if (!access) return notFound(c);
  const [owner] = access.filter.authorId
    ? await db.select({ n: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, access.filter.authorId)).limit(1)
    : [];
  return c.json(present(access.filter, owner?.n ?? null, user, canManageFilter(access)));
});

app.put('/rest/api/2/filter/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleFilter(user, parseId(c));
  if (!access) return notFound(c);
  if (!canManageFilter(access)) return c.json({ errorMessages: ['Forbidden'] }, 403);
  const parsed = updateBody.safeParse(await readJson(c));
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  const body = parsed.data;
  if (body.jql !== undefined) {
    const err = jqlError(body.jql);
    if (err) return badRequest(c, `Invalid JQL: ${err}`);
  }
  let shares: Share[] | undefined;
  if (body.shares !== undefined) {
    shares = dedupeShares(body.shares);
    const shareErr = await checkShareTargets(user, shares);
    if (shareErr) return badRequest(c, shareErr);
  }
  await db.update(schema.filters).set({
    name: body.name, jql: body.jql, favourite: body.favourite, shares, updatedAt: new Date(),
  }).where(eq(schema.filters.id, access.filter.id));
  return c.json({});
});

app.put('/rest/api/2/filter/:id/share', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleFilter(user, parseId(c));
  if (!access) return notFound(c);
  if (!canManageFilter(access)) return c.json({ errorMessages: ['Forbidden'] }, 403);
  const parsed = shareBody.safeParse(await readJson(c));
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  const shares = dedupeShares(parsed.data.shares);
  const shareErr = await checkShareTargets(user, shares);
  if (shareErr) return badRequest(c, shareErr);
  await db.update(schema.filters).set({ shares, updatedAt: new Date() }).where(eq(schema.filters.id, access.filter.id));
  return c.json({ shares });
});

app.delete('/rest/api/2/filter/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleFilter(user, parseId(c));
  if (!access) return notFound(c);
  if (!canManageFilter(access)) return c.json({ errorMessages: ['Forbidden'] }, 403);
  await db.delete(schema.filters).where(eq(schema.filters.id, access.filter.id));
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Subscriptions (email digest)                                       */
/* ------------------------------------------------------------------ */

const subscriptionBody = z.object({
  schedule: z.enum(['daily', 'weekly']),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  emptyPolicy: z.enum(['skip', 'send']).default('skip'),
}).strict().refine((b) => b.schedule === 'daily' || (b.weekday !== null && b.weekday !== undefined), {
  message: 'weekday is required for weekly schedules',
});

function presentSubscription(s: typeof schema.filterSubscriptions.$inferSelect) {
  return {
    filterId: String(s.filterId), schedule: s.schedule, hour: s.hour, weekday: s.weekday,
    emptyPolicy: s.emptyPolicy, lastSentAt: s.lastSentAt, createdAt: s.createdAt,
  };
}

app.get('/rest/api/2/filter/:id/subscription', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleFilter(user, parseId(c));
  if (!access) return notFound(c);
  const [sub] = await db.select().from(schema.filterSubscriptions)
    .where(and(eq(schema.filterSubscriptions.filterId, access.filter.id), eq(schema.filterSubscriptions.userId, user.id)))
    .limit(1);
  if (!sub) return c.json({ errorMessages: ['Subscription not found'] }, 404);
  return c.json(presentSubscription(sub));
});

app.put('/rest/api/2/filter/:id/subscription', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleFilter(user, parseId(c));
  if (!access) return notFound(c);
  const parsed = subscriptionBody.safeParse(await readJson(c));
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  const b = parsed.data;
  const values = {
    filterId: access.filter.id, userId: user.id, schedule: b.schedule, hour: b.hour,
    weekday: b.schedule === 'weekly' ? (b.weekday as number) : null, emptyPolicy: b.emptyPolicy,
  };
  const [sub] = await db.insert(schema.filterSubscriptions).values(values)
    .onConflictDoUpdate({
      target: [schema.filterSubscriptions.filterId, schema.filterSubscriptions.userId],
      set: { schedule: values.schedule, hour: values.hour, weekday: values.weekday, emptyPolicy: values.emptyPolicy },
    }).returning();
  return c.json(presentSubscription(sub));
});

app.delete('/rest/api/2/filter/:id/subscription', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = parseId(c);
  if (id <= 0 || id > 2_147_483_647) return notFound(c);
  // Own subscription only; no visibility check needed so a user can always drop a subscription to a filter that was unshared.
  await db.delete(schema.filterSubscriptions)
    .where(and(eq(schema.filterSubscriptions.filterId, id), eq(schema.filterSubscriptions.userId, user.id)));
  return c.json({});
});

export default app;
