import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, count, eq, inArray, sql } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { getBrowsableProjectIds } from '../services/browse';
import { hasGlobalPermission } from '../rbac/service';
import { issueVisibleFor } from '../security/issue-security';

/**
 * Teamspaces: a team (people and the projects it works in) with a combined view of its work. Any signed-in user can
 * create one and see the list; changing or deleting is for the lead, the creator and administrators. Numbers only
 * count what the viewer may see (project permissions and issue security).
 */
const app = new Hono<AppContext>();
const P = '/rest/api/2/teamspace';

const body = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).nullable().optional(),
  leadId: z.number().int().positive().nullable().optional(),
  memberIds: z.array(z.number().int().positive()).max(500).default([]),
  projectIds: z.array(z.number().int().positive()).max(200).default([]),
});

async function load(id: number) {
  const [t] = Number.isInteger(id) ? await db.select().from(schema.teamspaces).where(eq(schema.teamspaces.id, id)).limit(1) : [];
  return t ?? null;
}

async function mayEdit(user: { id: number }, t: typeof schema.teamspaces.$inferSelect) {
  return t.leadId === user.id || t.createdBy === user.id || (await hasGlobalPermission(user.id, 'SYSTEM_ADMIN'));
}

async function validate(user: any, b: z.infer<typeof body>): Promise<string | null> {
  const members = [...new Set(b.memberIds)];
  if (members.length) {
    const found = await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, members));
    if (found.length !== members.length) return 'Unknown user in the member list';
  }
  if (b.leadId) {
    const [l] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, b.leadId)).limit(1);
    if (!l) return 'Unknown lead';
  }
  const projects = [...new Set(b.projectIds)];
  if (projects.length) {
    const ok = new Set(await getBrowsableProjectIds(user));
    if (projects.some((p) => !ok.has(p))) return 'Unknown project, or you cannot browse it';
  }
  return null;
}

async function write(id: number, b: z.infer<typeof body>) {
  await db.transaction(async (tx) => {
    await tx.update(schema.teamspaces).set({ name: b.name, description: b.description ?? null, leadId: b.leadId ?? null }).where(eq(schema.teamspaces.id, id));
    await tx.delete(schema.teamspaceMembers).where(eq(schema.teamspaceMembers.teamspaceId, id));
    await tx.delete(schema.teamspaceProjects).where(eq(schema.teamspaceProjects.teamspaceId, id));
    const m = [...new Set(b.memberIds)];
    const p = [...new Set(b.projectIds)];
    if (m.length) await tx.insert(schema.teamspaceMembers).values(m.map((userId) => ({ teamspaceId: id, userId })));
    if (p.length) await tx.insert(schema.teamspaceProjects).values(p.map((projectId) => ({ teamspaceId: id, projectId })));
  });
}

const dup = (e: unknown) => /teamspaces_name_uniq|duplicate key/i.test(`${(e as any)?.message ?? ''} ${(e as any)?.cause?.message ?? ''} ${(e as any)?.code ?? ''} ${(e as any)?.cause?.code ?? ''}`) || (e as any)?.code === '23505' || (e as any)?.cause?.code === '23505';

app.get(P, requireAuth, async (c) => {
  const rows = await db.select().from(schema.teamspaces).orderBy(asc(schema.teamspaces.name));
  const mc = await db.select({ id: schema.teamspaceMembers.teamspaceId, n: count() }).from(schema.teamspaceMembers).groupBy(schema.teamspaceMembers.teamspaceId);
  const pc = await db.select({ id: schema.teamspaceProjects.teamspaceId, n: count() }).from(schema.teamspaceProjects).groupBy(schema.teamspaceProjects.teamspaceId);
  const m = new Map(mc.map((x) => [x.id, Number(x.n)])); const p = new Map(pc.map((x) => [x.id, Number(x.n)]));
  return c.json({ teamspaces: rows.map((t) => ({ id: t.id, name: t.name, description: t.description, leadId: t.leadId, members: m.get(t.id) ?? 0, projects: p.get(t.id) ?? 0 })) });
});

app.get(`${P}/:id`, requireAuth, async (c) => {
  const user = c.get('user')!;
  const t = await load(Number(c.req.param('id')));
  if (!t) return c.json({ errorMessages: ['Teamspace not found'] }, 404);
  const memberRows = await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.teamspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.teamspaceMembers.userId)).where(eq(schema.teamspaceMembers.teamspaceId, t.id)).orderBy(asc(schema.users.displayName));
  const linked = await db.select({ id: schema.projects.id, key: schema.projects.projectKey, name: schema.projects.name }).from(schema.teamspaceProjects)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.teamspaceProjects.projectId)).where(eq(schema.teamspaceProjects.teamspaceId, t.id)).orderBy(asc(schema.projects.projectKey));
  const browsable = new Set(await getBrowsableProjectIds(user));
  const projects = linked.filter((p) => browsable.has(p.id));
  const pids = projects.map((p) => p.id);
  const memberIds = memberRows.map((m) => m.id);

  let stats = { open: 0, inProgress: 0, doneLast7Days: 0, unassigned: 0, byMember: [] as { userId: number; open: number }[] };
  if (pids.length) {
    const vis = issueVisibleFor(user);
    const [agg] = (await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE s.category <> 'done')::int AS open,
        count(*) FILTER (WHERE s.category = 'in_progress' OR s.category = 'indeterminate')::int AS in_progress,
        count(*) FILTER (WHERE s.category = 'done' AND issues.resolved_at >= now() - interval '7 days')::int AS done7,
        count(*) FILTER (WHERE s.category <> 'done' AND issues.assignee_id IS NULL)::int AS unassigned
      FROM issues JOIN statuses s ON s.id = issues.status_id
      WHERE issues.project_id IN (${sql.join(pids.map((i) => sql`${i}`), sql`, `)}) AND ${vis}
    `)) as unknown as Array<{ open: number; in_progress: number; done7: number; unassigned: number }>;
    stats = { ...stats, open: agg?.open ?? 0, inProgress: agg?.in_progress ?? 0, doneLast7Days: agg?.done7 ?? 0, unassigned: agg?.unassigned ?? 0 };
    if (memberIds.length) {
      const rows = (await db.execute(sql`
        SELECT issues.assignee_id AS "userId", count(*)::int AS open
        FROM issues JOIN statuses s ON s.id = issues.status_id
        WHERE issues.project_id IN (${sql.join(pids.map((i) => sql`${i}`), sql`, `)}) AND s.category <> 'done'
          AND issues.assignee_id IN (${sql.join(memberIds.map((i) => sql`${i}`), sql`, `)}) AND ${vis}
        GROUP BY issues.assignee_id`)) as unknown as Array<{ userId: number; open: number }>;
      stats.byMember = rows;
    }
  }
  return c.json({
    id: t.id, name: t.name, description: t.description, leadId: t.leadId, members: memberRows, projects,
    hiddenProjects: linked.length - projects.length,
    canEdit: await mayEdit(user, t), stats,
    jql: pids.length ? `project in (${projects.map((p) => p.key).join(', ')}) AND resolution = Unresolved` : null,
  });
});

app.post(P, requireAuth, zValidator('json', body), async (c) => {
  const user = c.get('user')!;
  const b = c.req.valid('json');
  const bad = await validate(user, b);
  if (bad) return c.json({ errorMessages: [bad] }, 400);
  try {
    const [t] = await db.insert(schema.teamspaces).values({ name: b.name, description: b.description ?? null, leadId: b.leadId ?? user.id, createdBy: user.id }).returning();
    await write(t.id, { ...b, leadId: b.leadId ?? user.id });
    return c.json({ id: t.id }, 201);
  } catch (e) {
    if (dup(e)) return c.json({ errorMessages: ['A teamspace with this name already exists'] }, 409);
    throw e;
  }
});

app.put(`${P}/:id`, requireAuth, zValidator('json', body), async (c) => {
  const user = c.get('user')!;
  const t = await load(Number(c.req.param('id')));
  if (!t) return c.json({ errorMessages: ['Teamspace not found'] }, 404);
  if (!(await mayEdit(user, t))) return c.json({ errorMessages: ['Only the lead, the creator or an administrator can change a teamspace'] }, 403);
  const b = c.req.valid('json');
  const bad = await validate(user, b);
  if (bad) return c.json({ errorMessages: [bad] }, 400);
  try { await write(t.id, b); } catch (e) {
    if (dup(e)) return c.json({ errorMessages: ['A teamspace with this name already exists'] }, 409);
    throw e;
  }
  return c.json({ id: t.id });
});

app.delete(`${P}/:id`, requireAuth, async (c) => {
  const user = c.get('user')!;
  const t = await load(Number(c.req.param('id')));
  if (!t) return c.json({ errorMessages: ['Teamspace not found'] }, 404);
  if (!(await mayEdit(user, t))) return c.json({ errorMessages: ['Only the lead, the creator or an administrator can delete a teamspace'] }, 403);
  await db.delete(schema.teamspaces).where(eq(schema.teamspaces.id, t.id));
  return c.body(null, 204);
});

export default app;
