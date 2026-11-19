import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requirePermission, checkProjectPermission } from '../middleware/permissions';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, asc, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { buildIssueResponse, buildIssueResponses } from '../issues/service';
import { issueVisibleSql, redactIssueResponses } from '../security/issue-security';
import { getBrowsableProjectIds } from '../services/browse';
import { cacheMiddleware, invalidateCache } from '../middleware/cache';
import type { AppContext } from '../auth/middleware';
import { publishBoard, publishSprintForBoard } from '../realtime/publish';
import { publish } from '../realtime/hub';
import { z } from 'zod';
import { invalidateAgileCaches } from '../agile/cache';
import { validateBoardConfig } from '../agile/board-config';
import { parseJQLSafe, type JQLContext } from '../jql';
import { buildJQLContext } from './search';

/** Validates a board config body; the JQL of card colour rules is checked against the live name tables. */
async function checkedConfig(c: any, input: unknown): Promise<{ ok: true; config: Record<string, unknown> } | { ok: false; res: Response }> {
  const ctx: JQLContext = await buildJQLContext(c.get('user'));
  const v = validateBoardConfig(input, (jql) => {
    const parsed = parseJQLSafe(jql, ctx);
    return parsed.success ? null : parsed.error;
  });
  if (!v.ok) return { ok: false, res: c.json({ errorMessages: v.errors }, 400) };
  return { ok: true, config: v.config };
}

const app = new Hono<AppContext>();
app.use('/rest/api/2/board*', sessionMiddleware);

/* ------------------------------------------------------------------ */
/*  Boards                                                            */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/board', requireAuth, requirePermission('BROWSE_PROJECTS'), cacheMiddleware(300), async (c) => {
  const projectId = c.req.query('projectId');
  // Only boards of projects the caller may browse (requirePermission above is only "BROWSE somewhere").
  const browsable = await getBrowsableProjectIds(c.get('user')!);
  const conditions = [inArray(schema.boards.projectId, browsable.length ? browsable : [-1])];
  // Boards of archived projects are hidden from the default list (still reachable by id).
  if (c.req.query('includeArchived') !== 'true') {
    const archived = await db.select({ id: schema.projects.id }).from(schema.projects).where(isNotNull(schema.projects.archivedAt));
    if (archived.length) conditions.push(notInArray(schema.boards.projectId, archived.map((a) => a.id)));
  }
  if (projectId !== undefined && /^\d{1,9}$/.test(projectId)) conditions.push(eq(schema.boards.projectId, Number(projectId)));
  const boards = await db.select().from(schema.boards).where(and(...conditions));
  return c.json({
    startAt: 0,
    maxResults: boards.length,
    total: boards.length,
    values: boards.map((b: any) => ({
      id: String(b.id),
      name: b.name,
      type: b.type,
      projectId: b.projectId,
      filterId: b.filterId,
    })),
  });
});

app.get('/rest/api/2/board/:id', requireAuth, requirePermission('BROWSE_PROJECTS'), cacheMiddleware(300), async (c) => {
  const id = Number(c.req.param('id'));
  const boards = await db.select().from(schema.boards).where(eq(schema.boards.id, id)).limit(1);
  if (boards.length === 0) return c.json({ errorMessages: ['Board not found'] }, 404);
  const b = boards[0];

  const [columns, quickFilters] = await Promise.all([
    db.select()
      .from(schema.boardColumns)
      .where(eq(schema.boardColumns.boardId, id))
      .orderBy(asc(schema.boardColumns.sortOrder)),
    db.select()
      .from(schema.boardQuickFilters)
      .where(eq(schema.boardQuickFilters.boardId, id))
      .orderBy(asc(schema.boardQuickFilters.sortOrder)),
  ]);

  return c.json({
    id: String(b.id),
    name: b.name,
    type: b.type,
    projectId: b.projectId,
    filterId: b.filterId,
    config: b.config || {},
    columns: columns.map((col: any) => ({
      id: String(col.id),
      name: col.name,
      statusId: col.statusId,
      min: col.min,
      max: col.max,
      sortOrder: col.sortOrder,
    })),
    quickFilters: quickFilters.map((qf: any) => ({
      id: String(qf.id),
      name: qf.name,
      jql: qf.jql,
      sortOrder: qf.sortOrder,
    })),
  });
});

app.post('/rest/api/2/board', requireAuth, requirePermission('ADMINISTER_PROJECTS'), async (c) => {
  const body = await c.req.json();
  // The project is in the body, so requirePermission only checked "somewhere": check the target project.
  const targetProject = Number(body.projectId);
  if (!Number.isInteger(targetProject) || !(await checkProjectPermission(c.get('user')!, targetProject, 'ADMINISTER_PROJECTS'))) {
    return c.json({ errorMessages: ['Forbidden'] }, 403);
  }
  const cfg = await checkedConfig(c, body.config);
  if (!cfg.ok) return cfg.res;
  const [board] = await db.insert(schema.boards).values({
    name: body.name,
    type: body.type || 'kanban',
    projectId: body.projectId,
    filterId: body.filterId,
    config: cfg.config,
  }).returning();
  await invalidateCache(`veqsio:cache:*:/rest/api/2/board*`);
  return c.json({ id: String(board.id), name: board.name }, 201);
});

app.put('/rest/api/2/board/:id', requireAuth, requirePermission('ADMINISTER_PROJECTS'), async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    let config: Record<string, unknown> | undefined;
    if (body.config !== undefined) {
      const cfg = await checkedConfig(c, body.config);
      if (!cfg.ok) return cfg.res;
      config = cfg.config;
    }
    await db.update(schema.boards)
      .set({
        name: body.name,
        type: body.type,
        filterId: body.filterId,
        config,
      })
      .where(eq(schema.boards.id, id));
    await invalidateCache(`veqsio:cache:*:/rest/api/2/board*`);
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update board'] }, 500);
  }
});

app.delete('/rest/api/2/board/:id', requireAuth, requirePermission('ADMINISTER_PROJECTS'), async (c) => {
  try {
    const id = Number(c.req.param('id'));
    await db.delete(schema.boards).where(eq(schema.boards.id, id));
    await invalidateCache(`veqsio:cache:*:/rest/api/2/board*`);
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to delete board'] }, 500);
  }
});

/* ------------------------------------------------------------------ */
/*  Board Columns                                                     */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/board/:id/columns', requireAuth, requirePermission('BROWSE_PROJECTS'), cacheMiddleware(300), async (c) => {
  const id = Number(c.req.param('id'));
  const columns = await db.select()
    .from(schema.boardColumns)
    .where(eq(schema.boardColumns.boardId, id))
    .orderBy(asc(schema.boardColumns.sortOrder));
  return c.json({
    startAt: 0,
    maxResults: columns.length,
    total: columns.length,
    values: columns.map((col: any) => ({
      id: String(col.id),
      name: col.name,
      statusId: col.statusId,
      min: col.min,
      max: col.max,
      sortOrder: col.sortOrder,
    })),
  });
});

app.put('/rest/api/2/board/:id/columns', requireAuth, requirePermission('ADMINISTER_PROJECTS'), async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    const columns = body.columns || [];

    // Delete existing columns and recreate
    await db.delete(schema.boardColumns).where(eq(schema.boardColumns.boardId, id));

    for (const col of columns) {
      await db.insert(schema.boardColumns).values({
        boardId: id,
        name: col.name,
        statusId: col.statusId,
        min: col.min,
        max: col.max,
        sortOrder: col.sortOrder,
      });
    }

    await invalidateCache(`veqsio:cache:*:/rest/api/2/board*`);
    publishBoard(id, c.get('user')?.id);
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update columns'] }, 500);
  }
});

/* ------------------------------------------------------------------ */
/*  Quick Filters                                                     */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/board/:id/quick-filters', requireAuth, requirePermission('BROWSE_PROJECTS'), cacheMiddleware(300), async (c) => {
  const id = Number(c.req.param('id'));
  const filters = await db.select()
    .from(schema.boardQuickFilters)
    .where(eq(schema.boardQuickFilters.boardId, id))
    .orderBy(asc(schema.boardQuickFilters.sortOrder));
  return c.json({
    startAt: 0,
    maxResults: filters.length,
    total: filters.length,
    values: filters.map((f: any) => ({
      id: String(f.id),
      name: f.name,
      jql: f.jql,
      sortOrder: f.sortOrder,
    })),
  });
});

app.post('/rest/api/2/board/:id/quick-filters', requireAuth, requirePermission('ADMINISTER_PROJECTS'), async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    const [filter] = await db.insert(schema.boardQuickFilters).values({
      boardId: id,
      name: body.name,
      jql: body.jql,
      sortOrder: body.sortOrder || 0,
    }).returning();
    await invalidateCache(`veqsio:cache:*:/rest/api/2/board*`);
    return c.json({ id: String(filter.id), name: filter.name, jql: filter.jql }, 201);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to create quick filter'] }, 500);
  }
});

app.put('/rest/api/2/board/:id/quick-filters/:filterId', requireAuth, requirePermission('ADMINISTER_PROJECTS'), async (c) => {
  try {
    const filterId = Number(c.req.param('filterId'));
    const body = await c.req.json();
    await db.update(schema.boardQuickFilters)
      .set({ name: body.name, jql: body.jql, sortOrder: body.sortOrder })
      .where(eq(schema.boardQuickFilters.id, filterId));
    await invalidateCache(`veqsio:cache:*:/rest/api/2/board*`);
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update quick filter'] }, 500);
  }
});

app.delete('/rest/api/2/board/:id/quick-filters/:filterId', requireAuth, requirePermission('ADMINISTER_PROJECTS'), async (c) => {
  try {
    const filterId = Number(c.req.param('filterId'));
    await db.delete(schema.boardQuickFilters).where(eq(schema.boardQuickFilters.id, filterId));
    await invalidateCache(`veqsio:cache:*:/rest/api/2/board*`);
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to delete quick filter'] }, 500);
  }
});

/* ------------------------------------------------------------------ */
/*  Sprints                                                           */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/board/:id/sprint', requireAuth, requirePermission('BROWSE_PROJECTS'), cacheMiddleware(300), async (c) => {
  const boardId = Number(c.req.param('id'));
  const state = c.req.query('state');
  let conditions: any = eq(schema.sprints.boardId, boardId);
  if (state) {
    const states = state.split(',');
    conditions = and(conditions, inArray(schema.sprints.state, states));
  }
  const sprints = await db.select().from(schema.sprints).where(conditions);
  return c.json({
    startAt: 0,
    maxResults: sprints.length,
    total: sprints.length,
    values: sprints.map((s: any) => ({
      id: String(s.id),
      name: s.name,
      goal: s.goal,
      state: s.state,
      startDate: s.startDate?.toISOString(),
      endDate: s.endDate?.toISOString(),
      originBoardId: boardId,
    })),
  });
});

app.get('/rest/api/2/sprint/:id', requireAuth, requirePermission('BROWSE_PROJECTS'), cacheMiddleware(300), async (c) => {
  const id = Number(c.req.param('id'));
  const sprints = await db.select().from(schema.sprints).where(eq(schema.sprints.id, id)).limit(1);
  if (sprints.length === 0) return c.json({ errorMessages: ['Sprint not found'] }, 404);
  const s = sprints[0];
  return c.json({
    id: String(s.id),
    name: s.name,
    goal: s.goal,
    state: s.state,
    startDate: s.startDate?.toISOString(),
    endDate: s.endDate?.toISOString(),
    originBoardId: s.boardId,
  });
});

app.get('/rest/api/2/sprint/:id/issue', requireAuth, requirePermission('BROWSE_PROJECTS'), cacheMiddleware(300), async (c) => {
  const id = Number(c.req.param('id'));
  const maxResults = Math.min(Number(c.req.query('maxResults') || 1000), 1000);
  const sprintIssues = await db.select({ issueId: schema.sprintIssues.issueId }).from(schema.sprintIssues)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.sprintIssues.issueId))
    .where(and(eq(schema.sprintIssues.sprintId, id), issueVisibleSql(c.get('user')!.id)));
  const issueIds = sprintIssues.map((si) => si.issueId);
  const responses = await redactIssueResponses(c.get('user')!.id, await buildIssueResponses(issueIds.slice(0, maxResults)));
  return c.json({
    expand: 'names,schema',
    startAt: 0,
    maxResults,
    total: issueIds.length,
    issues: responses,
  });
});

/* ------------------------------------------------------------------ */
/*  Agile Board Routes (for sprint compatibility)                       */
/* ------------------------------------------------------------------ */

app.get('/rest/agile/1.0/board', requireAuth, requirePermission('BROWSE_PROJECTS'), cacheMiddleware(300), async (c) => {
  const projectId = c.req.query('projectId');
  // Only boards of projects the caller may browse (requirePermission above is only "BROWSE somewhere").
  const browsable = await getBrowsableProjectIds(c.get('user')!);
  const conditions = [inArray(schema.boards.projectId, browsable.length ? browsable : [-1])];
  // Boards of archived projects are hidden from the default list (still reachable by id).
  if (c.req.query('includeArchived') !== 'true') {
    const archived = await db.select({ id: schema.projects.id }).from(schema.projects).where(isNotNull(schema.projects.archivedAt));
    if (archived.length) conditions.push(notInArray(schema.boards.projectId, archived.map((a) => a.id)));
  }
  if (projectId !== undefined && /^\d{1,9}$/.test(projectId)) conditions.push(eq(schema.boards.projectId, Number(projectId)));
  const boards = await db.select().from(schema.boards).where(and(...conditions));
  return c.json({
    startAt: 0,
    maxResults: boards.length,
    total: boards.length,
    values: boards.map((b: any) => ({
      id: b.id,
      name: b.name,
      type: b.type,
      projectId: b.projectId,
    })),
  });
});

app.get('/rest/agile/1.0/board/:boardId/sprint', requireAuth, requirePermission('BROWSE_PROJECTS'), cacheMiddleware(300), async (c) => {
  const boardId = Number(c.req.param('boardId'));
  const state = c.req.query('state');
  let conditions: any = eq(schema.sprints.boardId, boardId);
  if (state) {
    const states = state.split(',');
    conditions = and(conditions, inArray(schema.sprints.state, states));
  }
  const sprints = await db.select().from(schema.sprints).where(conditions);
  return c.json({
    startAt: 0,
    maxResults: sprints.length,
    total: sprints.length,
    values: sprints.map((s: any) => ({
      id: s.id,
      name: s.name,
      goal: s.goal,
      state: s.state,
      startDate: s.startDate?.toISOString(),
      endDate: s.endDate?.toISOString(),
      originBoardId: boardId,
    })),
  });
});

const sprintDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid date');
const sprintFields = {
  name: z.string().trim().min(1, 'name is required').max(255),
  goal: z.string().max(2000).nullable().optional(),
  startDate: sprintDate.nullable().optional(),
  endDate: sprintDate.nullable().optional(),
};
const createSprintBody = z.object({ ...sprintFields, state: z.enum(['future']).optional() });
const updateSprintBody = z.object({
  ...sprintFields,
  name: sprintFields.name.optional(),
  state: z.enum(['future', 'active', 'closed']).optional(),
  completeDate: sprintDate.nullable().optional(),
});
const zodMessages = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);

app.post('/rest/agile/1.0/board/:boardId/sprint', requireAuth, async (c) => {
  try {
    const boardId = Number(c.req.param('boardId'));
    const user = c.get('user')!;

    const boards = await db.select().from(schema.boards).where(eq(schema.boards.id, boardId)).limit(1);
    if (boards.length === 0) return c.json({ errorMessages: ['Board not found'] }, 404);

    const allowed = await checkProjectPermission(user, boards[0].projectId, 'MANAGE_SPRINTS');
    if (!allowed) return c.json({ errorMessages: ['Forbidden'] }, 403);

    const parsed = createSprintBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ errorMessages: zodMessages(parsed.error) }, 400);
    const body = parsed.data;
    if (body.startDate && body.endDate && Date.parse(body.endDate) <= Date.parse(body.startDate)) {
      return c.json({ errorMessages: ['endDate: must be after the start date'] }, 400);
    }

    const [sprint] = await db.insert(schema.sprints).values({
      name: body.name,
      goal: body.goal || null,
      state: 'future',
      startDate: body.startDate ? new Date(body.startDate) : null,
      endDate: body.endDate ? new Date(body.endDate) : null,
      boardId,
    }).returning();
    publishSprintForBoard(boardId, sprint.id, user.id);
    await invalidateAgileCaches();

    return c.json({
      id: sprint.id,
      name: sprint.name,
      goal: sprint.goal,
      state: sprint.state,
      startDate: sprint.startDate?.toISOString(),
      endDate: sprint.endDate?.toISOString(),
      originBoardId: boardId,
    }, 201);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to create sprint'] }, 500);
  }
});

app.put('/rest/agile/1.0/sprint/:sprintId', requireAuth, async (c) => {
  try {
    const sprintId = Number(c.req.param('sprintId'));
    const user = c.get('user')!;

    const sprints = await db.select().from(schema.sprints).where(eq(schema.sprints.id, sprintId)).limit(1);
    if (sprints.length === 0) return c.json({ errorMessages: ['Sprint not found'] }, 404);

    const boards = await db.select().from(schema.boards).where(eq(schema.boards.id, sprints[0].boardId)).limit(1);
    const projectId = boards[0]?.projectId;
    if (!projectId) return c.json({ errorMessages: ['Project not found'] }, 404);

    const allowed = await checkProjectPermission(user, projectId, 'MANAGE_SPRINTS');
    if (!allowed) return c.json({ errorMessages: ['Forbidden'] }, 403);

    const parsed = updateSprintBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ errorMessages: zodMessages(parsed.error) }, 400);
    const body = parsed.data;
    const nextStart = body.startDate !== undefined ? (body.startDate ? new Date(body.startDate) : null) : sprints[0].startDate;
    const nextEnd = body.endDate !== undefined ? (body.endDate ? new Date(body.endDate) : null) : sprints[0].endDate;
    if (nextStart && nextEnd && nextEnd.getTime() <= nextStart.getTime()) {
      return c.json({ errorMessages: ['endDate: must be after the start date'] }, 400);
    }
    if (sprints[0].state === 'closed' && (body.name !== undefined || body.startDate !== undefined || body.endDate !== undefined)) {
      return c.json({ errorMessages: ['A closed sprint cannot be edited'] }, 400);
    }

    const setObj: Partial<typeof schema.sprints.$inferInsert> = {};
    if (body.name !== undefined) setObj.name = body.name;
    if (body.goal !== undefined) setObj.goal = body.goal;
    if (body.state !== undefined) setObj.state = body.state;
    if (body.startDate !== undefined) setObj.startDate = body.startDate ? new Date(body.startDate) : null;
    if (body.endDate !== undefined) setObj.endDate = body.endDate ? new Date(body.endDate) : null;
    if (body.completeDate !== undefined) setObj.completeDate = body.completeDate ? new Date(body.completeDate) : null;

    if (Object.keys(setObj).length === 0) return c.json({ errorMessages: ['Nothing to update'] }, 400);
    const [updated] = await db.update(schema.sprints).set(setObj).where(eq(schema.sprints.id, sprintId)).returning();
    publish('sprint.updated', { key: sprintId, projectId, actorId: user.id });
    await invalidateAgileCaches();

    return c.json({
      id: updated.id,
      name: updated.name,
      goal: updated.goal,
      state: updated.state,
      startDate: updated.startDate?.toISOString(),
      endDate: updated.endDate?.toISOString(),
      completeDate: updated.completeDate?.toISOString(),
      originBoardId: updated.boardId,
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update sprint'] }, 500);
  }
});

app.delete('/rest/agile/1.0/sprint/:sprintId', requireAuth, async (c) => {
  try {
    const sprintId = Number(c.req.param('sprintId'));
    const user = c.get('user')!;

    const sprints = await db.select().from(schema.sprints).where(eq(schema.sprints.id, sprintId)).limit(1);
    if (sprints.length === 0) return c.json({ errorMessages: ['Sprint not found'] }, 404);

    const boards = await db.select().from(schema.boards).where(eq(schema.boards.id, sprints[0].boardId)).limit(1);
    const projectId = boards[0]?.projectId;
    if (!projectId) return c.json({ errorMessages: ['Project not found'] }, 404);

    const allowed = await checkProjectPermission(user, projectId, 'MANAGE_SPRINTS');
    if (!allowed) return c.json({ errorMessages: ['Forbidden'] }, 403);

    // Active and closed sprints carry history (reports, velocity); only planned sprints can go.
    if (sprints[0].state !== 'future') {
      return c.json({ errorMessages: ['Only future sprints can be deleted'] }, 400);
    }

    // Issues return to the backlog: their membership rows go with the sprint.
    await db.delete(schema.sprintIssues).where(eq(schema.sprintIssues.sprintId, sprintId));
    await db.delete(schema.sprints).where(eq(schema.sprints.id, sprintId));
    publish('sprint.updated', { key: sprintId, projectId, actorId: user.id });
    await invalidateAgileCaches();

    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to delete sprint'] }, 500);
  }
});

/**
 * Which "card colour by rules" rule colours each card: first matching rule wins. Evaluated with the JQL engine
 * (so `currentUser()`, `flagged = true`, sprint functions all work) and only for issues the caller may browse.
 * Response: { by, colours: { "KEY-1": ruleIndex } }. Other modes are resolved in the browser from the card fields.
 */
app.post('/rest/agile/1.0/board/:boardId/card-colours', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const id = Number(c.req.param('boardId'));
  const [board] = Number.isInteger(id) ? await db.select().from(schema.boards).where(eq(schema.boards.id, id)).limit(1) : [];
  if (!board) return c.json({ errorMessages: ['Board not found'] }, 404);
  const user = c.get('user')!;
  if (!(await checkProjectPermission(user, board.projectId, 'BROWSE_PROJECTS'))) return c.json({ errorMessages: ['Board not found'] }, 404);
  const body = await c.req.json().catch(() => ({}));
  const keys: string[] = Array.isArray(body?.keys) ? body.keys.filter((k: unknown): k is string => typeof k === 'string').slice(0, 1000) : [];
  const cc = (board.config as any)?.cardColour;
  const rules: Array<{ jql: string; colour: string; name?: string }> = cc?.by === 'rules' && Array.isArray(cc.rules) ? cc.rules : [];
  const colours: Record<string, number> = {};
  if (rules.length && keys.length) {
    const browsable = await getBrowsableProjectIds(user);
    const rows = await db.select({ id: schema.issues.id, key: schema.issues.issueKey }).from(schema.issues)
      .where(and(inArray(schema.issues.issueKey, keys), inArray(schema.issues.projectId, browsable.length ? browsable : [-1])));
    const ctx = await buildJQLContext(user);
    const keyById = new Map(rows.map((r) => [r.id, r.key]));
    const ids = [...keyById.keys()];
    for (let i = 0; i < rules.length && ids.length; i++) {
      const parsed = parseJQLSafe(rules[i].jql, ctx);
      if (!parsed.success) continue;
      const hit = await db.select({ id: schema.issues.id }).from(schema.issues)
        .where(and(inArray(schema.issues.id, ids), parsed.result.where));
      for (const h of hit) {
        const k = keyById.get(h.id)!;
        if (colours[k] === undefined) colours[k] = i;
      }
    }
  }
  return c.json({ by: cc?.by ?? 'none', colours });
});

export default app;
