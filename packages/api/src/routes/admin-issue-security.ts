/**
 * Issue security schemes: administration (schemes, levels, members, default level, project association) and the
 * read endpoint the issue form uses to list the levels a project offers. The visibility rule itself lives in
 * security/issue-security.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { checkProjectPermission } from '../middleware/permissions';
import { bumpGeneration } from '../services/cache';
import { invalidateIssueCache } from '../middleware/cache';
import { LEVEL_MEMBER_TYPES, refreshSecurityLevelsFlag, schemeOfProject } from '../security/issue-security';

const app = new Hono<AppContext>();
const BASE = '/rest/api/2/admin/issuesecurity';
const admin = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const;

/** Visibility changes for many issues at once: drop every cached issue and search response. */
async function visibilityChanged() {
  await bumpGeneration('security');
  await invalidateIssueCache();
}

const id = (v: string) => (/^\d{1,9}$/.test(v) ? Number(v) : NaN);
const nf = (c: any, what: string) => c.json({ errorMessages: [`${what} not found`] }, 404);

app.get(BASE, ...admin, async (c) => {
  const schemes = await db.select().from(schema.issueSecuritySchemes).orderBy(asc(schema.issueSecuritySchemes.name));
  const levels = await db.select().from(schema.issueSecurityLevels).orderBy(asc(schema.issueSecurityLevels.sortOrder), asc(schema.issueSecurityLevels.id));
  const members = (await db.execute(sql`
    SELECT m.id, m.level_id AS "levelId", m.member_type AS "type", m.user_id AS "userId", m.group_id AS "groupId", m.project_role_id AS "roleId",
           u.display_name AS "userName", g.name AS "groupName", r.name AS "roleName"
    FROM issue_security_level_members m
    LEFT JOIN users u ON u.id = m.user_id LEFT JOIN groups g ON g.id = m.group_id LEFT JOIN project_roles r ON r.id = m.project_role_id
    ORDER BY m.id`)) as unknown as Array<{ id: number; levelId: number; type: string; userId: number | null; groupId: number | null; roleId: number | null; userName: string | null; groupName: string | null; roleName: string | null }>;
  const assoc = await db
    .select({ projectId: schema.issueSecuritySchemeAssociations.projectId, schemeId: schema.issueSecuritySchemeAssociations.schemeId, key: schema.projects.projectKey, name: schema.projects.name })
    .from(schema.issueSecuritySchemeAssociations)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.issueSecuritySchemeAssociations.projectId));
  const counts = (await db.execute(sql`SELECT security_level_id AS "levelId", count(*)::int AS n FROM issues WHERE security_level_id IS NOT NULL GROUP BY security_level_id`)) as unknown as Array<{ levelId: number; n: number }>;
  const countOf = new Map(counts.map((r) => [r.levelId, r.n]));
  const label = (m: (typeof members)[number]) => {
    switch (m.type) {
      case 'user': return m.userName ?? `User ${m.userId}`;
      case 'group': return m.groupName ?? `Group ${m.groupId}`;
      case 'role': return m.roleName ?? `Role ${m.roleId}`;
      case 'reporter': return 'Reporter';
      case 'assignee': return 'Assignee';
      case 'project_lead': return 'Project lead';
      default: return 'Any logged-in user';
    }
  };
  return c.json({
    schemes: schemes.map((s) => ({
      ...s,
      levels: levels.filter((l) => l.schemeId === s.id).map((l) => ({
        id: l.id, name: l.name, description: l.description, sortOrder: l.sortOrder, issueCount: countOf.get(l.id) ?? 0,
        members: members.filter((m) => m.levelId === l.id).map((m) => ({ id: m.id, type: m.type, userId: m.userId, groupId: m.groupId, roleId: m.roleId, label: label(m) })),
      })),
      projects: assoc.filter((a) => a.schemeId === s.id).map((a) => ({ id: a.projectId, key: a.key, name: a.name })),
    })),
  });
});

const schemeBody = z.object({ name: z.string().trim().min(1).max(255), description: z.string().max(2000).nullable().optional() });

app.post(BASE, ...admin, zValidator('json', schemeBody), async (c) => {
  const b = c.req.valid('json');
  const [row] = await db.insert(schema.issueSecuritySchemes).values({ name: b.name, description: b.description ?? null }).returning();
  return c.json(row, 201);
});

app.put(`${BASE}/:id`, ...admin, zValidator('json', schemeBody.partial().extend({ defaultLevelId: z.number().int().positive().nullable().optional() })), async (c) => {
  const sid = id(c.req.param('id'));
  const b = c.req.valid('json');
  const [s] = await db.select().from(schema.issueSecuritySchemes).where(eq(schema.issueSecuritySchemes.id, sid)).limit(1);
  if (!s) return nf(c, 'Scheme');
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.description !== undefined) patch.description = b.description;
  if (b.defaultLevelId !== undefined) {
    if (b.defaultLevelId !== null) {
      const [l] = await db.select({ id: schema.issueSecurityLevels.id }).from(schema.issueSecurityLevels)
        .where(and(eq(schema.issueSecurityLevels.id, b.defaultLevelId), eq(schema.issueSecurityLevels.schemeId, sid))).limit(1);
      if (!l) return c.json({ errorMessages: ['The default level must be a level of this scheme'] }, 400);
    }
    patch.defaultLevelId = b.defaultLevelId;
  }
  if (Object.keys(patch).length) await db.update(schema.issueSecuritySchemes).set(patch).where(eq(schema.issueSecuritySchemes.id, sid));
  return c.json({ id: sid });
});

app.delete(`${BASE}/:id`, ...admin, async (c) => {
  const sid = id(c.req.param('id'));
  const [s] = await db.select().from(schema.issueSecuritySchemes).where(eq(schema.issueSecuritySchemes.id, sid)).limit(1);
  if (!s) return nf(c, 'Scheme');
  const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM issues i JOIN issue_security_levels l ON l.id = i.security_level_id WHERE l.scheme_id = ${sid}`)) as unknown as Array<{ n: number }>;
  if (n > 0) return c.json({ errorMessages: [`${n} issue(s) still use a level of this scheme. Remove the level from them first.`] }, 409);
  await db.delete(schema.issueSecuritySchemes).where(eq(schema.issueSecuritySchemes.id, sid));
  await visibilityChanged();
  return c.json({});
});

/* ---- levels ---- */
const levelBody = z.object({ name: z.string().trim().min(1).max(255), description: z.string().max(2000).nullable().optional() });

app.post(`${BASE}/:id/level`, ...admin, zValidator('json', levelBody), async (c) => {
  const sid = id(c.req.param('id'));
  const [s] = await db.select({ id: schema.issueSecuritySchemes.id }).from(schema.issueSecuritySchemes).where(eq(schema.issueSecuritySchemes.id, sid)).limit(1);
  if (!s) return nf(c, 'Scheme');
  const b = c.req.valid('json');
  const [{ max }] = (await db.execute(sql`SELECT COALESCE(MAX(sort_order), 0)::int AS max FROM issue_security_levels WHERE scheme_id = ${sid}`)) as unknown as Array<{ max: number }>;
  const [row] = await db.insert(schema.issueSecurityLevels).values({ schemeId: sid, name: b.name, description: b.description ?? null, sortOrder: max + 1 }).returning();
  await refreshSecurityLevelsFlag(); // the fast path in issueVisibleSql must stop at once
  return c.json(row, 201);
});

app.put(`${BASE}/:id/level/:levelId`, ...admin, zValidator('json', levelBody.partial()), async (c) => {
  const sid = id(c.req.param('id')), lid = id(c.req.param('levelId'));
  const b = c.req.valid('json');
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.description !== undefined) patch.description = b.description;
  if (!Object.keys(patch).length) return c.json({ id: lid });
  const r = await db.update(schema.issueSecurityLevels).set(patch).where(and(eq(schema.issueSecurityLevels.id, lid), eq(schema.issueSecurityLevels.schemeId, sid))).returning({ id: schema.issueSecurityLevels.id });
  if (!r.length) return nf(c, 'Level');
  await visibilityChanged(); // the level name is part of cached issue responses
  return c.json({ id: lid });
});

app.delete(`${BASE}/:id/level/:levelId`, ...admin, async (c) => {
  const sid = id(c.req.param('id')), lid = id(c.req.param('levelId'));
  const [l] = await db.select().from(schema.issueSecurityLevels).where(and(eq(schema.issueSecurityLevels.id, lid), eq(schema.issueSecurityLevels.schemeId, sid))).limit(1);
  if (!l) return nf(c, 'Level');
  const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM issues WHERE security_level_id = ${lid}`)) as unknown as Array<{ n: number }>;
  if (n > 0) return c.json({ errorMessages: [`${n} issue(s) use this level. Change their level first, deleting it would expose them.`] }, 409);
  await db.update(schema.issueSecuritySchemes).set({ defaultLevelId: null }).where(and(eq(schema.issueSecuritySchemes.id, sid), eq(schema.issueSecuritySchemes.defaultLevelId, lid)));
  await db.delete(schema.issueSecurityLevels).where(eq(schema.issueSecurityLevels.id, lid));
  await visibilityChanged();
  return c.json({});
});

/* ---- members ---- */
const memberBody = z.object({
  type: z.enum(LEVEL_MEMBER_TYPES),
  userId: z.number().int().positive().optional(),
  groupId: z.number().int().positive().optional(),
  roleId: z.number().int().positive().optional(),
}).strict();

app.post(`${BASE}/:id/level/:levelId/member`, ...admin, zValidator('json', memberBody), async (c) => {
  const sid = id(c.req.param('id')), lid = id(c.req.param('levelId'));
  const b = c.req.valid('json');
  const [l] = await db.select({ id: schema.issueSecurityLevels.id }).from(schema.issueSecurityLevels).where(and(eq(schema.issueSecurityLevels.id, lid), eq(schema.issueSecurityLevels.schemeId, sid))).limit(1);
  if (!l) return nf(c, 'Level');
  const need = b.type === 'user' ? b.userId : b.type === 'group' ? b.groupId : b.type === 'role' ? b.roleId : 0;
  if (need === undefined) return c.json({ errorMessages: [`A ${b.type} member needs ${b.type === 'role' ? 'roleId' : b.type + 'Id'}`] }, 400);
  if (b.type === 'user' && !(await db.select({ i: schema.users.id }).from(schema.users).where(eq(schema.users.id, b.userId!)).limit(1)).length) return nf(c, 'User');
  if (b.type === 'group' && !(await db.select({ i: schema.groups.id }).from(schema.groups).where(eq(schema.groups.id, b.groupId!)).limit(1)).length) return nf(c, 'Group');
  if (b.type === 'role' && !(await db.select({ i: schema.projectRoles.id }).from(schema.projectRoles).where(eq(schema.projectRoles.id, b.roleId!)).limit(1)).length) return nf(c, 'Role');
  const dup = await db.select({ id: schema.issueSecurityLevelMembers.id }).from(schema.issueSecurityLevelMembers).where(and(
    eq(schema.issueSecurityLevelMembers.levelId, lid), eq(schema.issueSecurityLevelMembers.memberType, b.type),
    b.type === 'user' ? eq(schema.issueSecurityLevelMembers.userId, b.userId!) : b.type === 'group' ? eq(schema.issueSecurityLevelMembers.groupId, b.groupId!) : b.type === 'role' ? eq(schema.issueSecurityLevelMembers.projectRoleId, b.roleId!) : undefined,
  )).limit(1);
  if (dup.length) return c.json({ errorMessages: ['Already a member of this level'] }, 409);
  const [row] = await db.insert(schema.issueSecurityLevelMembers).values({
    levelId: lid, memberType: b.type,
    userId: b.type === 'user' ? b.userId : null, groupId: b.type === 'group' ? b.groupId : null, projectRoleId: b.type === 'role' ? b.roleId : null,
  }).returning();
  await visibilityChanged();
  return c.json(row, 201);
});

app.delete(`${BASE}/:id/level/:levelId/member/:memberId`, ...admin, async (c) => {
  const lid = id(c.req.param('levelId')), mid = id(c.req.param('memberId'));
  const r = await db.delete(schema.issueSecurityLevelMembers).where(and(eq(schema.issueSecurityLevelMembers.id, mid), eq(schema.issueSecurityLevelMembers.levelId, lid))).returning({ id: schema.issueSecurityLevelMembers.id });
  if (!r.length) return nf(c, 'Member');
  await visibilityChanged();
  return c.json({});
});

/* ---- project association ---- */
app.put(`${BASE}/project/:projectId`, ...admin, zValidator('json', z.object({
  schemeId: z.number().int().positive().nullable(),
  /** old level id (as string key) -> new level id, or null to remove the level. Required for every level that is in use. */
  levelMapping: z.record(z.string(), z.number().int().positive().nullable()).optional(),
})), async (c) => {
  const pid = id(c.req.param('projectId'));
  const b = c.req.valid('json');
  const [p] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, pid)).limit(1);
  if (!p) return nf(c, 'Project');
  if (b.schemeId !== null && !(await db.select({ i: schema.issueSecuritySchemes.id }).from(schema.issueSecuritySchemes).where(eq(schema.issueSecuritySchemes.id, b.schemeId)).limit(1)).length) return nf(c, 'Scheme');
  const current = await schemeOfProject(pid);
  if ((current?.id ?? null) === b.schemeId) return c.json({});
  // Issues of the project that carry a level of the old scheme must be mapped explicitly: a silent reset would expose them.
  const used = (await db.execute(sql`SELECT security_level_id AS "levelId", count(*)::int AS n FROM issues WHERE project_id = ${pid} AND security_level_id IS NOT NULL GROUP BY security_level_id`)) as unknown as Array<{ levelId: number; n: number }>;
  const mapping = b.levelMapping ?? {};
  const unmapped = used.filter((u) => !(String(u.levelId) in mapping));
  if (unmapped.length) return c.json({ errorMessages: ['Issues in this project use security levels of the current scheme. Map every used level to a level of the new scheme (or null to remove it).'], usedLevels: used }, 409);
  const targets = [...new Set(Object.values(mapping).filter((x): x is number => x !== null))];
  if (targets.length) {
    const ok = await db.select({ id: schema.issueSecurityLevels.id }).from(schema.issueSecurityLevels).where(and(inArray(schema.issueSecurityLevels.id, targets), b.schemeId === null ? sql`false` : eq(schema.issueSecurityLevels.schemeId, b.schemeId)));
    if (ok.length !== targets.length) return c.json({ errorMessages: ['A mapped level does not belong to the new scheme'] }, 400);
  }
  await db.transaction(async (tx) => {
    for (const u of used) {
      await tx.update(schema.issues).set({ securityLevelId: mapping[String(u.levelId)] ?? null }).where(and(eq(schema.issues.projectId, pid), eq(schema.issues.securityLevelId, u.levelId)));
    }
    await tx.delete(schema.issueSecuritySchemeAssociations).where(eq(schema.issueSecuritySchemeAssociations.projectId, pid));
    if (b.schemeId !== null) await tx.insert(schema.issueSecuritySchemeAssociations).values({ projectId: pid, schemeId: b.schemeId });
  });
  await visibilityChanged();
  return c.json({});
});

/** The levels a project offers (for the issue form) and whether the caller may set them. */
app.use('/rest/api/2/project/*/issuesecurity', sessionMiddleware);
app.get('/rest/api/2/project/:key/issuesecurity', requireAuth, async (c) => {
  const user = c.get('user')!;
  const [p] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.projectKey, c.req.param('key'))).limit(1);
  if (!p || !(await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS'))) return nf(c, 'Project');
  const scheme = await schemeOfProject(p.id);
  if (!scheme) return c.json({ scheme: null, defaultLevelId: null, levels: [], canSet: false });
  const levels = await db.select({ id: schema.issueSecurityLevels.id, name: schema.issueSecurityLevels.name, description: schema.issueSecurityLevels.description })
    .from(schema.issueSecurityLevels).where(eq(schema.issueSecurityLevels.schemeId, scheme.id)).orderBy(asc(schema.issueSecurityLevels.sortOrder), asc(schema.issueSecurityLevels.id));
  return c.json({ scheme: { id: scheme.id, name: scheme.name }, defaultLevelId: scheme.defaultLevelId, levels, canSet: await checkProjectPermission(user, p.id, 'SET_ISSUE_SECURITY') });
});

export default app;
