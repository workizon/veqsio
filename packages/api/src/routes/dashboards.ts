import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requirePermission, getBrowsableProjectIds, checkGlobalPermission } from '../middleware/permissions';
import { issueVisibleSql } from '../security/issue-security';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@veqsio/db';
import { eq, inArray, and } from 'drizzle-orm';
import type { AppContext } from '../auth/middleware';
import { validateGadget } from '../dashboards/gadget-config';
import { GadgetQueryError, loadScopedRows } from '../dashboards/gadget-query';
import { computeGadget, isRowGadget, needsMulti } from '../dashboards/gadget-compute';
import { computeAverageAge, computeResolutionTime, parsePeriod } from '../dashboards/gadget-stats';

import { db } from '../db';

const app = new Hono<AppContext>();
app.use('/rest/api/2/dashboard*', sessionMiddleware);

app.get('/rest/api/2/dashboard', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const user = c.get('user')!;
  const dashboards = await db.select().from(schema.dashboards)
    .where(eq(schema.dashboards.ownerId, user.id));
  const [pref] = await db.select().from(schema.dashboardUserPrefs).where(eq(schema.dashboardUserPrefs.userId, user.id)).limit(1);
  return c.json({
    startAt: 0,
    maxResults: dashboards.length,
    total: dashboards.length,
    isLast: true,
    dashboards: dashboards.map(d => ({
      id: String(d.id),
      name: d.name,
      owner: { id: d.ownerId },
      isDefault: pref?.defaultDashboardId === d.id,
    })),
  });
});

// The dashboard that opens as the user's home (null = the standard "Your work" page).
app.get('/rest/api/2/dashboard/default', requireAuth, async (c) => {
  const user = c.get('user')!;
  const [pref] = await db.select().from(schema.dashboardUserPrefs).where(eq(schema.dashboardUserPrefs.userId, user.id)).limit(1);
  return c.json({ id: pref?.defaultDashboardId != null ? String(pref.defaultDashboardId) : null });
});

app.put('/rest/api/2/dashboard/default', requireAuth, async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const id = body?.id === null || body?.id === undefined || body?.id === '' ? null : Number(body.id);
  if (id !== null) {
    if (!Number.isInteger(id)) return c.json({ errorMessages: ['id must be a dashboard id or null'] }, 400);
    const [d] = await db.select().from(schema.dashboards).where(eq(schema.dashboards.id, id)).limit(1);
    if (!d || d.ownerId !== user.id) return c.json({ errorMessages: ['Dashboard not found'] }, 404);
  }
  await db.insert(schema.dashboardUserPrefs).values({ userId: user.id, defaultDashboardId: id })
    .onConflictDoUpdate({ target: schema.dashboardUserPrefs.userId, set: { defaultDashboardId: id } });
  return c.json({ id: id === null ? null : String(id) });
});

app.post('/rest/api/2/dashboard', requireAuth, async (c) => {
  const body = await c.req.json();
  const user = c.get('user')!;
  const [dashboard] = await db.insert(schema.dashboards).values({
    name: body.name,
    ownerId: user.id,
    layout: body.layout || '2-column',
  }).returning();
  return c.json({ id: String(dashboard.id), name: dashboard.name }, 201);
});

app.get('/rest/api/2/dashboard/:id', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const id = Number(c.req.param('id'));
  const dashboards = await db.select().from(schema.dashboards).where(eq(schema.dashboards.id, id)).limit(1);
  if (dashboards.length === 0) return c.json({ errorMessages: ['Dashboard not found'] }, 404);
  const d = dashboards[0];
  // Dashboards are private to their owner (and system administrators): other users get the same 404 as for a missing id.
  const viewer = c.get('user')!;
  if (d.ownerId !== viewer.id && !(await checkGlobalPermission(viewer, 'ADMINISTER'))) {
    return c.json({ errorMessages: ['Dashboard not found'] }, 404);
  }
  const gadgets = await db.select().from(schema.dashboardGadgets).where(eq(schema.dashboardGadgets.dashboardId, id));
  return c.json({
    id: String(d.id),
    name: d.name,
    layout: d.layout,
    gadgets: gadgets
      .sort((a, b) => (a.rowIndex ?? 0) - (b.rowIndex ?? 0) || (a.columnIndex ?? 0) - (b.columnIndex ?? 0))
      .map(g => ({
        id: String(g.id),
        type: g.gadgetType,
        title: typeof (g.config as any)?.title === 'string' ? (g.config as any).title : '',
        column: g.columnIndex,
        row: g.rowIndex,
        position: { column: g.columnIndex ?? 0, row: g.rowIndex ?? 0 },
        config: g.config,
      })),
  });
});

app.put('/rest/api/2/dashboard/:id', requireAuth, async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const user = c.get('user')!;
    const dashboards = await db.select().from(schema.dashboards).where(eq(schema.dashboards.id, id)).limit(1);
    if (dashboards.length === 0) return c.json({ errorMessages: ['Dashboard not found'] }, 404);
    if (dashboards[0].ownerId !== user.id) return c.json({ errorMessages: ['Forbidden'] }, 403);

    const body = await c.req.json();
    const patch: { name?: string; layout?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 255);
    if (typeof body.layout === 'string') patch.layout = body.layout.slice(0, 20);

    let gadgetRows: Array<typeof schema.dashboardGadgets.$inferInsert> | null = null;
    if (body.gadgets !== undefined) {
      if (!Array.isArray(body.gadgets) || body.gadgets.length > 50) {
        return c.json({ errorMessages: ['gadgets must be an array of at most 50 items'] }, 400);
      }
      gadgetRows = [];
      for (const g of body.gadgets) {
        if (!g || typeof g.type !== 'string' || !g.type || g.type.length > 50) {
          return c.json({ errorMessages: ['Each gadget needs a type'] }, 400);
        }
        const config = g.config && typeof g.config === 'object' && !Array.isArray(g.config) ? { ...g.config } : {};
        if (typeof g.title === 'string' && g.title) (config as any).title = g.title.slice(0, 200);
        gadgetRows.push({
          dashboardId: id,
          gadgetType: g.type,
          columnIndex: Math.max(0, Math.floor(Number(g.position?.column ?? g.column ?? 0)) || 0),
          rowIndex: Math.max(0, Math.floor(Number(g.position?.row ?? g.row ?? 0)) || 0),
          config,
        });
      }
    }

    await db.transaction(async (tx) => {
      await tx.update(schema.dashboards).set(patch).where(eq(schema.dashboards.id, id));
      if (gadgetRows) {
        await tx.delete(schema.dashboardGadgets).where(eq(schema.dashboardGadgets.dashboardId, id));
        if (gadgetRows.length) await tx.insert(schema.dashboardGadgets).values(gadgetRows);
      }
    });
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update dashboard'] }, 500);
  }
});

app.delete('/rest/api/2/dashboard/:id', requireAuth, async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const user = c.get('user')!;
    const dashboards = await db.select().from(schema.dashboards).where(eq(schema.dashboards.id, id)).limit(1);
    if (dashboards.length === 0) return c.json({ errorMessages: ['Dashboard not found'] }, 404);
    if (dashboards[0].ownerId !== user.id) return c.json({ errorMessages: ['Forbidden'] }, 403);

    await db.delete(schema.dashboards).where(eq(schema.dashboards.id, id));
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to delete dashboard'] }, 500);
  }
});

/** Created/resolved timestamps of issues in projects the current user may browse. */
async function browsableIssueDates(c: any) {
  const projectIds = await getBrowsableProjectIds(c.get('user'));
  if (projectIds.length === 0) return [];
  return db.select({ createdAt: schema.issues.createdAt, resolvedAt: schema.issues.resolvedAt })
    .from(schema.issues).where(and(inArray(schema.issues.projectId, projectIds), issueVisibleSql(c.get('user')?.id ?? null)));
}

function gadgetOpts(c: any) {
  const period = parsePeriod(c.req.query('period'));
  const count = Math.min(Math.max(parseInt(c.req.query('count') || '30', 10) || 30, 1), 90);
  return { period, count };
}

app.get('/rest/api/2/dashboard/gadgets/average-age', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const opts = gadgetOpts(c);
  const rows = await browsableIssueDates(c);
  return c.json({ ...opts, data: computeAverageAge(rows, opts) });
});

app.get('/rest/api/2/dashboard/gadgets/resolution-time', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const opts = gadgetOpts(c);
  const rows = await browsableIssueDates(c);
  return c.json({ ...opts, data: computeResolutionTime(rows, opts) });
});

/**
 * Data of one JQL-based gadget (statistics, workload, two-dimensional table, number tile, recently created, heat map,
 * due-date calendar). The rows are scoped to what the caller may browse and see (project permissions, issue security).
 */
app.post('/rest/api/2/dashboard/gadget-data', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const body = await c.req.json().catch(() => null) as { type?: unknown; config?: unknown } | null;
  const type = typeof body?.type === 'string' ? body.type : '';
  if (!isRowGadget(type)) return c.json({ errorMessages: [`Unsupported gadget type: ${type || '(none)'}`] }, 400);
  const v = validateGadget({ type, config: body?.config });
  if (!v.ok) return c.json({ errorMessages: v.errors }, 400);
  const config = v.value.config as Record<string, unknown>;
  try {
    const { rows, total } = await loadScopedRows(c.get('user')!, {
      jql: typeof config.jql === 'string' ? config.jql : undefined,
      filterId: config.filterId ? String(config.filterId) : undefined,
      multi: needsMulti(config),
      limit: 5000,
    });
    return c.json({ type, ...computeGadget(type, config, rows, total) });
  } catch (e) {
    if (e instanceof GadgetQueryError) return c.json({ errorMessages: [e.message] }, e.status);
    throw e;
  }
});

export default app;
