import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, count, desc, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { validateJql } from '../jql/autocomplete';
import { isAdminUser } from '../services/browse';
import {
  checkShareTargets, dedupeShares, normalizeShares, sharedVisibleSql, sharesSchema, type Share,
} from '../services/filter-access';
import { recordAudit } from '../audit/log';
import {
  BUILTIN_VIEWS, buildFilterJql, describeQuery, getBuiltinView, normalizeConfig, parseConfig, viewConfigSchema,
  type ViewConfig,
} from '../views/config';
import { COLUMN_LABELS, columnValue } from '../views/columns';
import { MAX_VIEW_PAGE, ViewQueryError, executeView, exportIds, loadExportChunk } from '../views/executor';
import {
  EXPORT_CHUNK, EXPORT_CONTENT_TYPES, EXPORT_FORMATS, csvHeader, csvLine, exportFileName, exportMaxRows,
  type ExportFormat,
} from '../views/export';
import { buildXlsx } from '../views/xlsx';
import { getClientIP } from '../middleware/rate-limit'

type User = typeof schema.users.$inferSelect;
type ViewRow = typeof schema.views.$inferSelect;

/**
 * Saved views. Same visibility model as saved filters: owner, users/groups in `shares`, members who can browse a
 * listed project, everyone for a global share; administrators see everything. Anything the caller cannot see is
 * answered with 404. A view only stores a query and display settings: it is executed AS THE VIEWER, so it never
 * reveals an issue the viewer cannot browse. Built-in views (`builtin:<key>`) are generated, not stored.
 */
const app = new Hono<AppContext>();
app.use('/rest/api/2/views*', sessionMiddleware);

const notFound = (c: any) => c.json({ errorMessages: ['View not found'] }, 404);
const badRequest = (c: any, msg: string) => c.json({ errorMessages: [msg] }, 400);
const forbidden = (c: any) => c.json({ errorMessages: ['Forbidden'] }, 403);
const readJson = (c: any): Promise<unknown> => c.req.json().catch(() => null);

const MAX_VIEWS_PER_USER = 500;
const name = z.string().trim().min(1).max(255);
const description = z.string().trim().max(2000);

const createBody = z.object({
  name,
  description: description.optional(),
  config: viewConfigSchema,
  shares: sharesSchema.optional(),
  favourite: z.boolean().optional(),
}).strict();

const updateBody = z.object({
  name: name.optional(),
  description: description.nullable().optional(),
  config: viewConfigSchema.optional(),
  shares: sharesSchema.optional(),
}).strict();

const executeBody = z.object({
  config: viewConfigSchema,
  startAt: z.number().int().min(0).max(100_000).optional(),
  maxResults: z.number().int().min(1).max(MAX_VIEW_PAGE).optional(),
}).strict();

const exportBody = z.object({
  config: viewConfigSchema,
  format: z.enum(EXPORT_FORMATS),
  name: z.string().trim().max(100).optional(),
}).strict();

const duplicateBody = z.object({ name: name.optional() }).strict();
const favouriteBody = z.object({ favourite: z.boolean() }).strict();

function intQuery(v: string | undefined, def: number, min: number, max: number): number {
  const n = v === undefined || v === '' ? def : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
}

/** Checks the JQL of the query (and the generated one for the simple filters) with the existing validator. */
function queryError(config: ViewConfig): string | null {
  const jql = config.query.jql.trim();
  if (jql) {
    const r = validateJql(jql);
    if (!r.valid) return `Invalid JQL: ${r.errors[0].message}`;
  }
  const fj = buildFilterJql(config.query.filters);
  if (fj) {
    const r = validateJql(fj);
    if (!r.valid) return `Invalid filter: ${r.errors[0].message}`;
  }
  return null;
}

const favouriteKey = (id: number | string) => String(id);

async function favouriteKeys(user: User): Promise<Set<string>> {
  const rows = await db.select({ k: schema.viewFavourites.viewKey }).from(schema.viewFavourites)
    .where(eq(schema.viewFavourites.userId, user.id));
  return new Set(rows.map((r) => r.k));
}

function presentBuiltin(b: (typeof BUILTIN_VIEWS)[number], favs: Set<string>) {
  return {
    id: b.id, builtin: true, name: b.name, description: b.description, owner: null,
    favourite: favs.has(b.id), editable: false, shared: false,
    layout: b.config.layout, query: describeQuery(b.config.query), config: b.config,
    createdAt: null, updatedAt: null,
  };
}

function present(v: ViewRow, ownerName: string | null, user: User, canManage: boolean, favs: Set<string>, withConfig: boolean) {
  const config = normalizeConfig(v.config);
  const shares = normalizeShares(v.shares);
  return {
    id: String(v.id), builtin: false, name: v.name, description: v.description,
    owner: { id: v.ownerId, displayName: ownerName },
    favourite: favs.has(favouriteKey(v.id)),
    editable: canManage, shared: shares.length > 0,
    layout: config.layout, query: describeQuery(config.query),
    ...(withConfig ? { config } : {}),
    ...(canManage ? { shares } : {}),
    createdAt: v.createdAt, updatedAt: v.updatedAt,
  };
}

interface Access { view: ViewRow; isOwner: boolean; isAdmin: boolean }

async function getVisibleView(user: User, id: number): Promise<Access | null> {
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) return null;
  const admin = await isAdminUser(user);
  const where = admin ? eq(schema.views.id, id)
    : and(eq(schema.views.id, id), await sharedVisibleSql(user, schema.views.shares, schema.views.ownerId))!;
  const [view] = await db.select().from(schema.views).where(where).limit(1);
  return view ? { view, isOwner: view.ownerId === user.id, isAdmin: admin } : null;
}

const canManage = (a: Access) => a.isOwner || a.isAdmin;

async function ownerName(v: ViewRow): Promise<string | null> {
  if (!v.ownerId) return null;
  const [o] = await db.select({ n: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, v.ownerId)).limit(1);
  return o?.n ?? null;
}

const clientIp = (c: any) => { const ip = getClientIP(c); return ip === 'unknown' ? null : ip };

/* ------------------------------------------------------------------ */
/*  Execution and export (shared by stored, built-in and ad-hoc views) */
/* ------------------------------------------------------------------ */

async function runView(c: any, user: User, config: ViewConfig, meta: unknown) {
  const startAt = intQuery(c.req.query('startAt'), 0, 0, 100_000);
  const maxResults = intQuery(c.req.query('maxResults'), 100, 1, MAX_VIEW_PAGE);
  return runWith(c, user, config, meta, startAt, maxResults);
}

async function runWith(c: any, user: User, config: ViewConfig, meta: unknown, startAt: number, maxResults: number) {
  try {
    const result = await executeView(user, config, startAt, maxResults);
    return c.json({ view: meta, config, ...result });
  } catch (err) {
    if (err instanceof ViewQueryError) return badRequest(c, err.message);
    throw err;
  }
}

async function exportView(c: any, user: User, config: ViewConfig, format: ExportFormat, label: string, target: string) {
  let ids: number[]; let truncated: boolean;
  try {
    ({ ids, truncated } = await exportIds(user, config, exportMaxRows()));
  } catch (err) {
    if (err instanceof ViewQueryError) return badRequest(c, err.message);
    throw err;
  }
  const columns = config.columns;
  const headers = columns.map((col) => COLUMN_LABELS[col]);
  void recordAudit({
    actorId: user.id, actorName: user.username, action: 'VIEW_EXPORTED', targetType: 'view', target,
    method: c.req.method, path: c.req.path, status: 200, ip: clientIp(c),
    details: { format, rows: ids.length, truncated, columns: columns.length, query: describeQuery(config.query).slice(0, 500) },
  });
  const common = {
    'Content-Type': EXPORT_CONTENT_TYPES[format],
    'Content-Disposition': `attachment; filename="${exportFileName(label, format)}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Export-Rows': String(ids.length),
    'X-Export-Truncated': truncated ? 'true' : 'false',
  };
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += EXPORT_CHUNK) chunks.push(ids.slice(i, i + EXPORT_CHUNK));
  const rowsOf = async (chunk: number[]) => (await loadExportChunk(chunk)).map((issue) => columns.map((col) => columnValue(issue, col)));

  if (format === 'xlsx') {
    const all: ReturnType<typeof columnValue>[][] = [];
    for (const chunk of chunks) all.push(...await rowsOf(chunk));
    return new Response(buildXlsx(label, headers, all) as unknown as BodyInit, { headers: common });
  }

  const enc = new TextEncoder();
  let next = 0; let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          if (format === 'csv') controller.enqueue(enc.encode('﻿' + csvHeader(headers)));
          else {
            controller.enqueue(enc.encode(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"view":${JSON.stringify(label)},"query":${JSON.stringify(describeQuery(config.query))},"columns":${JSON.stringify(columns)},"count":${ids.length},"truncated":${truncated},"issues":[`));
          }
        }
        if (next >= chunks.length) {
          if (format === 'json') controller.enqueue(enc.encode(']}\n'));
          controller.close();
          return;
        }
        const rows = await rowsOf(chunks[next]);
        let out = '';
        if (format === 'csv') for (const r of rows) out += csvLine(r);
        else out = rows.map((r, i) => (next > 0 || i > 0 ? ',' : '') + JSON.stringify(Object.fromEntries(columns.map((col, k) => [col, r[k]])))).join('');
        next++;
        controller.enqueue(enc.encode(out));
      } catch (err) {
        console.error('[views-export]', err);
        controller.error(err);
      }
    },
  });
  return new Response(stream, { headers: common });
}

/* ------------------------------------------------------------------ */
/*  List                                                               */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/views', requireAuth, async (c) => {
  const user = c.get('user')!;
  const startAt = intQuery(c.req.query('startAt'), 0, 0, 100_000);
  const maxResults = intQuery(c.req.query('maxResults'), 50, 1, 100);
  const scopeQ = c.req.query('scope') ?? 'all';
  if (!['all', 'mine', 'shared', 'favourites'].includes(scopeQ)) return badRequest(c, 'scope must be all, mine, shared or favourites');
  const all = c.req.query('all') === 'true';
  const admin = await isAdminUser(user);
  if (all && !admin) return forbidden(c);
  const search = (c.req.query('search') || '').trim().slice(0, 100);
  const esc = search.replace(/[\\%_]/g, (m) => `\\${m}`);
  const favs = await favouriteKeys(user);

  const conds: SQL[] = [];
  if (!(all && admin)) conds.push(await sharedVisibleSql(user, schema.views.shares, schema.views.ownerId));
  if (search) conds.push(or(ilike(schema.views.name, `%${esc}%`), ilike(schema.views.description, `%${esc}%`))!);
  if (scopeQ === 'mine') conds.push(eq(schema.views.ownerId, user.id));
  if (scopeQ === 'shared') conds.push(ne(schema.views.ownerId, user.id));
  if (scopeQ === 'favourites') {
    conds.push(sql`EXISTS (SELECT 1 FROM view_favourites f WHERE f.user_id = ${user.id} AND f.view_key = ${schema.views.id}::text)`);
  }
  const where = and(...conds);
  const [rows, [{ total }]] = await Promise.all([
    db.select({ v: schema.views, ownerName: schema.users.displayName }).from(schema.views)
      .leftJoin(schema.users, eq(schema.users.id, schema.views.ownerId))
      .where(where).orderBy(asc(schema.views.name), desc(schema.views.id)).limit(maxResults).offset(startAt),
    db.select({ total: count() }).from(schema.views).where(where),
  ]);

  const needle = search.toLowerCase();
  const builtin = scopeQ === 'all' || scopeQ === 'favourites'
    ? BUILTIN_VIEWS.filter((b) => (!needle || b.name.toLowerCase().includes(needle) || b.description.toLowerCase().includes(needle))
      && (scopeQ === 'all' || favs.has(b.id)))
      .map((b) => presentBuiltin(b, favs))
    : [];
  return c.json({
    startAt, maxResults, total: Number(total), isLast: startAt + rows.length >= Number(total),
    builtin: startAt === 0 ? builtin : [],
    values: rows.map((r) => present(r.v, r.ownerName, user, r.v.ownerId === user.id || admin, favs, false)),
  });
});

/* ------------------------------------------------------------------ */
/*  Ad-hoc execution / export (unsaved changes, search results)         */
/* ------------------------------------------------------------------ */

app.post('/rest/api/2/views/execute', requireAuth, async (c) => {
  const user = c.get('user')!;
  const parsed = executeBody.safeParse(await readJson(c));
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  const config = parseConfig(parsed.data.config);
  if (!config.ok) return badRequest(c, config.error);
  const err = queryError(config.config);
  if (err) return badRequest(c, err);
  return runWith(c, user, config.config, null, parsed.data.startAt ?? 0, parsed.data.maxResults ?? 100);
});

app.post('/rest/api/2/views/export', requireAuth, async (c) => {
  const user = c.get('user')!;
  const parsed = exportBody.safeParse(await readJson(c));
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  const config = parseConfig(parsed.data.config);
  if (!config.ok) return badRequest(c, config.error);
  const err = queryError(config.config);
  if (err) return badRequest(c, err);
  return exportView(c, user, config.config, parsed.data.format, parsed.data.name || 'issues', 'adhoc');
});

/* ------------------------------------------------------------------ */
/*  Built-in views                                                     */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/views/builtin/:builtin', requireAuth, async (c) => {
  const b = getBuiltinView(c.req.param('builtin'));
  if (!b) return notFound(c);
  return c.json(presentBuiltin(b, await favouriteKeys(c.get('user')!)));
});

app.get('/rest/api/2/views/builtin/:builtin/issues', requireAuth, async (c) => {
  const b = getBuiltinView(c.req.param('builtin'));
  if (!b) return notFound(c);
  const user = c.get('user')!;
  return runView(c, user, b.config, presentBuiltin(b, await favouriteKeys(user)));
});

app.get('/rest/api/2/views/builtin/:builtin/export', requireAuth, async (c) => {
  const b = getBuiltinView(c.req.param('builtin'));
  if (!b) return notFound(c);
  const format = c.req.query('format') as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) return badRequest(c, 'format must be csv, xlsx or json');
  return exportView(c, c.get('user')!, b.config, format, b.name, b.id);
});

app.post('/rest/api/2/views/builtin/:builtin/duplicate', requireAuth, async (c) => {
  const b = getBuiltinView(c.req.param('builtin'));
  if (!b) return notFound(c);
  const user = c.get('user')!;
  const parsed = duplicateBody.safeParse((await readJson(c)) ?? {});
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  return duplicate(c, user, parsed.data.name ?? `Copy of ${b.name}`, b.config, null);
});

app.put('/rest/api/2/views/builtin/:builtin/favourite', requireAuth, async (c) => {
  const b = getBuiltinView(c.req.param('builtin'));
  if (!b) return notFound(c);
  const parsed = favouriteBody.safeParse(await readJson(c));
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  await setFavourite(c.get('user')!, b.id, parsed.data.favourite);
  return c.json({ id: b.id, favourite: parsed.data.favourite });
});

async function setFavourite(user: User, key: string, on: boolean) {
  if (on) await db.insert(schema.viewFavourites).values({ userId: user.id, viewKey: key }).onConflictDoNothing();
  else await db.delete(schema.viewFavourites)
    .where(and(eq(schema.viewFavourites.userId, user.id), eq(schema.viewFavourites.viewKey, key)));
}

async function duplicate(c: any, user: User, newName: string, config: ViewConfig, description: string | null) {
  if (await tooMany(user)) return badRequest(c, `You can have at most ${MAX_VIEWS_PER_USER} views`);
  const [row] = await db.insert(schema.views).values({
    name: newName.slice(0, 255), description, ownerId: user.id, config, shares: [],
  }).returning();
  return c.json(present(row, user.displayName, user, true, new Set(), true), 201);
}

async function tooMany(user: User): Promise<boolean> {
  const [{ n }] = await db.select({ n: count() }).from(schema.views).where(eq(schema.views.ownerId, user.id));
  return Number(n) >= MAX_VIEWS_PER_USER;
}

/* ------------------------------------------------------------------ */
/*  CRUD                                                               */
/* ------------------------------------------------------------------ */

app.post('/rest/api/2/views', requireAuth, async (c) => {
  const user = c.get('user')!;
  const parsed = createBody.safeParse(await readJson(c));
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  const body = parsed.data;
  const config = parseConfig(body.config);
  if (!config.ok) return badRequest(c, config.error);
  const qe = queryError(config.config);
  if (qe) return badRequest(c, qe);
  const shares = dedupeShares(body.shares ?? []);
  const shareErr = await checkShareTargets(user, shares);
  if (shareErr) return badRequest(c, shareErr);
  if (await tooMany(user)) return badRequest(c, `You can have at most ${MAX_VIEWS_PER_USER} views`);
  const [row] = await db.insert(schema.views).values({
    name: body.name, description: body.description || null, ownerId: user.id, config: config.config, shares,
  }).returning();
  if (body.favourite) await setFavourite(user, favouriteKey(row.id), true);
  return c.json(present(row, user.displayName, user, true, new Set(body.favourite ? [favouriteKey(row.id)] : []), true), 201);
});

app.get('/rest/api/2/views/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleView(user, Number(c.req.param('id')));
  if (!access) return notFound(c);
  return c.json(present(access.view, await ownerName(access.view), user, canManage(access), await favouriteKeys(user), true));
});

app.put('/rest/api/2/views/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleView(user, Number(c.req.param('id')));
  if (!access) return notFound(c);
  if (!canManage(access)) return forbidden(c);
  const parsed = updateBody.safeParse(await readJson(c));
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  const body = parsed.data;
  let config: ViewConfig | undefined;
  if (body.config !== undefined) {
    const r = parseConfig(body.config);
    if (!r.ok) return badRequest(c, r.error);
    const qe = queryError(r.config);
    if (qe) return badRequest(c, qe);
    config = r.config;
  }
  let shares: Share[] | undefined;
  if (body.shares !== undefined) {
    shares = dedupeShares(body.shares);
    const shareErr = await checkShareTargets(user, shares);
    if (shareErr) return badRequest(c, shareErr);
  }
  const [row] = await db.update(schema.views).set({
    name: body.name, description: body.description === undefined ? undefined : body.description || null,
    config, shares, updatedAt: new Date(),
  }).where(eq(schema.views.id, access.view.id)).returning();
  return c.json(present(row, await ownerName(row), user, true, await favouriteKeys(user), true));
});

app.delete('/rest/api/2/views/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleView(user, Number(c.req.param('id')));
  if (!access) return notFound(c);
  if (!canManage(access)) return forbidden(c);
  await db.delete(schema.views).where(eq(schema.views.id, access.view.id));
  await db.delete(schema.viewFavourites).where(eq(schema.viewFavourites.viewKey, favouriteKey(access.view.id)));
  void recordAudit({
    actorId: user.id, actorName: user.username, action: 'VIEW_DELETED', targetType: 'view', target: String(access.view.id),
    method: 'DELETE', path: c.req.path, status: 200, ip: clientIp(c), details: { name: access.view.name.slice(0, 100) },
  });
  return c.json({});
});

app.post('/rest/api/2/views/:id/duplicate', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleView(user, Number(c.req.param('id')));
  if (!access) return notFound(c);
  const parsed = duplicateBody.safeParse((await readJson(c)) ?? {});
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  return duplicate(c, user, parsed.data.name ?? `Copy of ${access.view.name}`, normalizeConfig(access.view.config), access.view.description);
});

app.put('/rest/api/2/views/:id/favourite', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleView(user, Number(c.req.param('id')));
  if (!access) return notFound(c);
  const parsed = favouriteBody.safeParse(await readJson(c));
  if (!parsed.success) return badRequest(c, 'Invalid request body');
  await setFavourite(user, favouriteKey(access.view.id), parsed.data.favourite);
  return c.json({ id: String(access.view.id), favourite: parsed.data.favourite });
});

app.get('/rest/api/2/views/:id/issues', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleView(user, Number(c.req.param('id')));
  if (!access) return notFound(c);
  const meta = present(access.view, await ownerName(access.view), user, canManage(access), await favouriteKeys(user), false);
  return runView(c, user, normalizeConfig(access.view.config), meta);
});

app.get('/rest/api/2/views/:id/export', requireAuth, async (c) => {
  const user = c.get('user')!;
  const access = await getVisibleView(user, Number(c.req.param('id')));
  if (!access) return notFound(c);
  const format = c.req.query('format') as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) return badRequest(c, 'format must be csv, xlsx or json');
  return exportView(c, user, normalizeConfig(access.view.config), format, access.view.name, String(access.view.id));
});

export default app;
