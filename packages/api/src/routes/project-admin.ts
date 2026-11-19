import { sniff } from '../migration/rest/avatars';
import { dispatchChatNotification } from '../integrations/notify';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requirePermission } from '../middleware/permissions';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { PERMISSION_INFO, PERMISSION_CATEGORY_ORDER } from '../rbac/permission-info';
import { hasGlobalPermission } from '../rbac/service';
import type { AppContext } from '../auth/middleware';
import { uploadFile } from '../storage/service';

const app = new Hono<AppContext>();
app.use('/rest/api/2/project/*', sessionMiddleware);

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

async function getProjectByKey(key: string) {
  const rows = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
  return rows[0] || null;
}

/* ------------------------------------------------------------------ */
/*  Components                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Permissions of one project (read only): who may do what, from its permission scheme  */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/project/:key/permissions', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const key = c.req.param('key');
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const [assoc] = await db.select().from(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, project.id)).limit(1);
  const [scheme] = assoc ? await db.select().from(schema.permissionSchemes).where(eq(schema.permissionSchemes.id, assoc.schemeId)).limit(1) : [];
  const entries = scheme ? await db.select().from(schema.permissionEntries).where(eq(schema.permissionEntries.schemeId, scheme.id)) : [];
  const usedBy = scheme ? await db.select({ n: sql<number>`count(*)::int` }).from(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.schemeId, scheme.id)) : [{ n: 0 }];

  const ids = (f: (e: (typeof entries)[number]) => number | null) => [...new Set(entries.map(f).filter((v): v is number => !!v))];
  const roles = ids((e) => e.projectRoleId).length ? await db.select().from(schema.projectRoles).where(inArray(schema.projectRoles.id, ids((e) => e.projectRoleId))) : [];
  const groups = ids((e) => e.groupId).length ? await db.select().from(schema.groups).where(inArray(schema.groups.id, ids((e) => e.groupId))) : [];
  const users = ids((e) => e.userId).length ? await db.select().from(schema.users).where(inArray(schema.users.id, ids((e) => e.userId))) : [];
  const actors = roles.length ? await db.select().from(schema.projectRoleActors).where(and(eq(schema.projectRoleActors.projectId, project.id), inArray(schema.projectRoleActors.roleId, roles.map((r) => r.id)))) : [];
  const actorCount = (roleId: number) => actors.filter((a) => a.roleId === roleId).length;

  const permissions = Object.entries(PERMISSION_INFO).map(([permission, info]) => {
    const own = entries.filter((e) => e.permissionKey === permission);
    return {
      key: permission, ...info,
      grantedTo: {
        anyone: own.some((e) => e.anonymous),
        loggedIn: own.some((e) => e.anyUser),
        projectLead: own.some((e) => e.projectLead),
        roles: own.filter((e) => e.projectRoleId).map((e) => roles.find((r) => r.id === e.projectRoleId)).filter(Boolean).map((r) => ({ id: r!.id, name: r!.name, members: actorCount(r!.id) })),
        groups: own.filter((e) => e.groupId).map((e) => groups.find((g) => g.id === e.groupId)).filter(Boolean).map((g) => ({ id: g!.id, name: g!.name })),
        users: own.filter((e) => e.userId).map((e) => users.find((u) => u.id === e.userId)).filter(Boolean).map((u) => ({ id: u!.id, name: u!.displayName })),
      },
    };
  });
  // Changing a scheme is a system administrator's job (it is shared by projects), so only they get the edit controls.
  const canEdit = await hasGlobalPermission(c.get('user')!.id, 'ADMINISTER');
  const allSchemes = canEdit ? await db.select({ id: schema.permissionSchemes.id, name: schema.permissionSchemes.name }).from(schema.permissionSchemes) : [];
  return c.json({
    canEdit,
    projectId: project.id,
    scheme: scheme ? { id: scheme.id, name: scheme.name, description: scheme.description, usedByProjects: usedBy[0]?.n ?? 0 } : null,
    schemes: allSchemes,
    categories: PERMISSION_CATEGORY_ORDER,
    permissions,
  });
});

const componentCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  leadId: z.number().int().optional(),
});

const componentUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  leadId: z.number().int().optional(),
});

app.get('/rest/api/2/project/:key/components', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const key = c.req.param('key');
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const comps = await db.select().from(schema.components).where(eq(schema.components.projectId, project.id));
  const leadIds = comps.map((c) => c.leadId).filter(Boolean) as number[];
  const users = leadIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, leadIds)) : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  return c.json(
    comps.map((comp) => ({
      id: comp.id,
      name: comp.name,
      description: comp.description,
      lead: comp.leadId ? { id: comp.leadId, displayName: userMap.get(comp.leadId)?.displayName } : null,
    }))
  );
});

app.post('/rest/api/2/project/:key/components', requireAuth, requirePermission('PROJECT_ADMIN'), zValidator('json', componentCreateSchema), async (c) => {
  const key = c.req.param('key');
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const body = c.req.valid('json');
  const [comp] = await db.insert(schema.components).values({ projectId: project.id, name: body.name, description: body.description, leadId: body.leadId }).returning();
  return c.json({ id: comp.id, name: comp.name, description: comp.description, leadId: comp.leadId }, 201);
});

app.put('/rest/api/2/project/:key/components/:id', requireAuth, requirePermission('PROJECT_ADMIN'), zValidator('json', componentUpdateSchema), async (c) => {
  const key = c.req.param('key');
  const id = Number(c.req.param('id'));
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const body = c.req.valid('json');
  const [comp] = await db.update(schema.components).set({ name: body.name, description: body.description, leadId: body.leadId }).where(and(eq(schema.components.id, id), eq(schema.components.projectId, project.id))).returning();
  if (!comp) return c.json({ errorMessages: ['Component not found'] }, 404);
  return c.json({ id: comp.id, name: comp.name, description: comp.description, leadId: comp.leadId });
});

app.delete('/rest/api/2/project/:key/components/:id', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const key = c.req.param('key');
  const id = Number(c.req.param('id'));
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  await db.delete(schema.components).where(and(eq(schema.components.id, id), eq(schema.components.projectId, project.id)));
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Versions                                                            */
/* ------------------------------------------------------------------ */

const versionCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  released: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const versionUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  released: z.boolean().optional(),
  archived: z.boolean().optional(),
});

app.get('/rest/api/2/project/:key/versions', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const key = c.req.param('key');
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const versions = await db.select().from(schema.versions).where(eq(schema.versions.projectId, project.id)).orderBy(desc(schema.versions.id));
  return c.json(versions.map((v) => ({ id: v.id, name: v.name, description: v.description, startDate: v.startDate, releaseDate: v.releaseDate, released: v.released, archived: v.archived })));
});

app.post('/rest/api/2/project/:key/versions', requireAuth, requirePermission('PROJECT_ADMIN'), zValidator('json', versionCreateSchema), async (c) => {
  const key = c.req.param('key');
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const body = c.req.valid('json');
  const [version] = await db.insert(schema.versions).values({ projectId: project.id, name: body.name, description: body.description, startDate: body.startDate || null, releaseDate: body.releaseDate || null, released: body.released ?? false, archived: body.archived ?? false }).returning();
  return c.json({ id: version.id, name: version.name, description: version.description, startDate: version.startDate, releaseDate: version.releaseDate, released: version.released, archived: version.archived }, 201);
});

app.put('/rest/api/2/project/:key/versions/:id', requireAuth, requirePermission('PROJECT_ADMIN'), zValidator('json', versionUpdateSchema), async (c) => {
  const key = c.req.param('key');
  const id = Number(c.req.param('id'));
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const body = c.req.valid('json');
  const setObj: Partial<typeof schema.versions.$inferInsert> = {};
  if (body.name !== undefined) setObj.name = body.name;
  if (body.description !== undefined) setObj.description = body.description;
  if (body.startDate !== undefined) setObj.startDate = body.startDate;
  if (body.releaseDate !== undefined) setObj.releaseDate = body.releaseDate;
  if (body.released !== undefined) setObj.released = body.released;
  if (body.archived !== undefined) setObj.archived = body.archived;

  const [before] = await db.select({ released: schema.versions.released }).from(schema.versions).where(and(eq(schema.versions.id, id), eq(schema.versions.projectId, project.id))).limit(1);
  const [version] = await db.update(schema.versions).set(setObj).where(and(eq(schema.versions.id, id), eq(schema.versions.projectId, project.id))).returning();
  if (!version) return c.json({ errorMessages: ['Version not found'] }, 404);
  if (version.released && before && !before.released) {
    // Chat channels subscribed to "release published" (integrations); never blocks or fails the request.
    dispatchChatNotification('release.published', { projectId: project.id, projectName: project.name, versionName: version.name, description: version.description ?? '', releaseDate: version.releaseDate ?? undefined });
  }
  return c.json({ id: version.id, name: version.name, description: version.description, startDate: version.startDate, releaseDate: version.releaseDate, released: version.released, archived: version.archived });
});

app.delete('/rest/api/2/project/:key/versions/:id', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const key = c.req.param('key');
  const id = Number(c.req.param('id'));
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  await db.delete(schema.versions).where(and(eq(schema.versions.id, id), eq(schema.versions.projectId, project.id)));
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Avatar Upload                                                       */
/* ------------------------------------------------------------------ */

app.post('/rest/api/2/project/:key/avatar', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  try {
    const key = c.req.param('key');
    const project = await getProjectByKey(key);
    if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return c.json({ errorMessages: ['No file provided'] }, 400);
    if (!file.type.startsWith('image/')) return c.json({ errorMessages: ['Only image files are allowed'] }, 400);
    if (file.size > 2 * 1024 * 1024) return c.json({ errorMessages: ['The picture is too large (2 MB at most)'] }, 400);
    // the bytes decide, not the claimed type: SVG and other markup can carry script and are not accepted as a picture
    const mime = sniff(Buffer.from(await file.slice(0, 16).arrayBuffer()));
    if (!mime) return c.json({ errorMessages: ['Use a PNG, JPEG, GIF or WebP picture'] }, 400);

    const result = await uploadFile(key, 'avatars', file, file.name, mime);
    const [updated] = await db.update(schema.projects).set({ avatarUrl: result.publicUrl, updatedAt: new Date() }).where(eq(schema.projects.projectKey, key)).returning();
    return c.json({ id: updated.id, avatarUrl: result.publicUrl }, 201);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to upload avatar'] }, 500);
  }
});

/* ------------------------------------------------------------------ */
/*  Project Roles (read + manage)                                       */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/project/:key/role', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const key = c.req.param('key');
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const roles = await db.select().from(schema.projectRoles);
  const actors = await db.select().from(schema.projectRoleActors).where(eq(schema.projectRoleActors.projectId, project.id));

  const userIds = actors.map((a) => a.userId).filter(Boolean) as number[];
  const users = userIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  const actorUserMap = new Map(users.map((u) => [u.id, { id: u.id, displayName: u.displayName, username: u.username }]));


  const groupIds = actors.map((a) => a.groupId).filter(Boolean) as number[];
  const groups = groupIds.length ? await db.select().from(schema.groups).where(inArray(schema.groups.id, groupIds)) : [];
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  const result = roles.map((role) => {
    const roleActors = actors.filter((a) => a.roleId === role.id);
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      actors: roleActors.map((a) => ({
        id: a.id,
        type: a.userId ? 'user' : a.groupId ? 'group' : 'unknown',
        user: a.userId ? actorUserMap.get(a.userId) || { id: a.userId, displayName: userMap.get(a.userId)?.displayName, username: '' } : null,
        group: a.groupId ? { id: a.groupId, name: groupMap.get(a.groupId)?.name } : null,
      })),
    };
  });

  return c.json(result);
});

app.get('/rest/api/2/project/:key/role/:id', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const key = c.req.param('key');
  const roleId = Number(c.req.param('id'));
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const role = await db.select().from(schema.projectRoles).where(eq(schema.projectRoles.id, roleId)).limit(1);
  if (role.length === 0) return c.json({ errorMessages: ['Role not found'] }, 404);

  const actors = await db.select().from(schema.projectRoleActors).where(and(eq(schema.projectRoleActors.projectId, project.id), eq(schema.projectRoleActors.roleId, roleId)));

  const userIds = actors.map((a) => a.userId).filter(Boolean) as number[];
  const users = userIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  const actorUserMap = new Map(users.map((u) => [u.id, { id: u.id, displayName: u.displayName, username: u.username }]));


  const groupIds = actors.map((a) => a.groupId).filter(Boolean) as number[];
  const groups = groupIds.length ? await db.select().from(schema.groups).where(inArray(schema.groups.id, groupIds)) : [];
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  return c.json({
    id: role[0].id,
    name: role[0].name,
    description: role[0].description,
    actors: actors.map((a) => ({
      id: a.id,
      type: a.userId ? 'user' : a.groupId ? 'group' : 'unknown',
      user: a.userId ? actorUserMap.get(a.userId) || { id: a.userId, displayName: userMap.get(a.userId)?.displayName, username: '' } : null,
      group: a.groupId ? { id: a.groupId, name: groupMap.get(a.groupId)?.name } : null,
    })),
  });
});

app.post('/rest/api/2/project/:key/role/:id', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const key = c.req.param('key');
  const roleId = Number(c.req.param('id'));
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const body = await c.req.json();
  const userId = body.user?.id ? Number(body.user.id) : null;
  const groupId = body.group?.id ? Number(body.group.id) : null;
  const username = body.user?.name || body.username;
  const groupName = body.group?.name || body.groupname;

  let resolvedUserId: number | null = userId;
  let resolvedGroupId: number | null = groupId;

  if (!resolvedUserId && username) {
    const u = await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
    if (u.length > 0) resolvedUserId = u[0].id;
  }

  if (!resolvedGroupId && groupName) {
    const g = await db.select().from(schema.groups).where(eq(schema.groups.name, groupName)).limit(1);
    if (g.length > 0) resolvedGroupId = g[0].id;
  }

  if (!resolvedUserId && !resolvedGroupId) {
    return c.json({ errorMessages: ['user or group required'] }, 400);
  }

  const existing = await db
    .select()
    .from(schema.projectRoleActors)
    .where(
      and(
        eq(schema.projectRoleActors.projectId, project.id),
        eq(schema.projectRoleActors.roleId, roleId),
        resolvedUserId ? eq(schema.projectRoleActors.userId, resolvedUserId) : eq(schema.projectRoleActors.groupId, resolvedGroupId!)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return c.json({ errorMessages: ['Actor already assigned to this role'] }, 409);
  }

  const [actor] = await db.insert(schema.projectRoleActors).values({ projectId: project.id, roleId, userId: resolvedUserId, groupId: resolvedGroupId }).returning();
  return c.json({ id: actor.id, projectId: project.id, roleId, userId: resolvedUserId, groupId: resolvedGroupId }, 201);
});

app.delete('/rest/api/2/project/:key/role/:id', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const key = c.req.param('key');
  const roleId = Number(c.req.param('id'));
  const project = await getProjectByKey(key);
  if (!project) return c.json({ errorMessages: ['Project not found'] }, 404);

  const user = c.req.query('user');
  const group = c.req.query('group');

  if (!user && !group) {
    return c.json({ errorMessages: ['user or group query parameter required'] }, 400);
  }

  let conditions = and(eq(schema.projectRoleActors.projectId, project.id), eq(schema.projectRoleActors.roleId, roleId));

  if (user) {
    const u = await db.select().from(schema.users).where(eq(schema.users.username, user)).limit(1);
    if (u.length === 0) return c.json({ errorMessages: ['User not found'] }, 404);
    conditions = and(conditions, eq(schema.projectRoleActors.userId, u[0].id));
  } else if (group) {
    const g = await db.select().from(schema.groups).where(eq(schema.groups.name, group)).limit(1);
    if (g.length === 0) return c.json({ errorMessages: ['Group not found'] }, 404);
    conditions = and(conditions, eq(schema.projectRoleActors.groupId, g[0].id));
  }

  await db.delete(schema.projectRoleActors).where(conditions);
  return c.json({});
});

export default app;
