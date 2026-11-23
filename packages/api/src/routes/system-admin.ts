import { assertSeatAvailable, SeatLimitError } from '../license/seats';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, like, or, and, count, inArray, sql } from 'drizzle-orm';
import { ROLE_TEMPLATE, roleTemplateEntries } from '../rbac/role-template';
import { hashPassword } from '../auth/password';
import { checkPasswordPolicy, getInstanceSettings } from '../settings/instance';
import { GLOBAL_PERMISSIONS, PROJECT_PERMISSIONS } from '../rbac/types';
import { setupFullTextSearch } from '../search/fulltext';
import { getSmtpConfig, getTransporter } from '../services/email';
import type { AppContext } from '../auth/middleware';
import { VERSION, VERSION_NUMBERS, buildId } from '../version';
import { publicBranding } from '../branding/store';

const app = new Hono<AppContext>();

app.use('/rest/api/2/user*', sessionMiddleware);
app.use('/rest/api/2/group*', sessionMiddleware);
app.use('/rest/api/2/permissionscheme*', sessionMiddleware);
app.use('/rest/api/2/permissions', sessionMiddleware);
app.use('/rest/api/2/role', sessionMiddleware);

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */

const createUserSchema = z.object({
  username: z.string().min(1).max(255),
  email: z.string().email(),
  displayName: z.string().min(1).max(255),
  password: z.string().min(6),
  active: z.boolean().optional().default(true),
  avatarUrl: z.string().max(2000).refine((v) => v === '' || /^https:\/\//i.test(v) || /^\/(?!\/)[^\\]*$/.test(v), 'A picture address starts with https:// or /').optional(),
  groups: z.array(z.string()).optional(),
});

app.post('/rest/api/2/user', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', createUserSchema), async (c) => {
  const body = c.req.valid('json');
  if (body.username.toLowerCase().startsWith('agent:')) return c.json({ errorMessages: ['The agent: user name prefix is reserved for AI agents'] }, 400);

  const existing = await db
    .select()
    .from(schema.users)
    .where(or(eq(schema.users.username, body.username), eq(schema.users.email, body.email)))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ errorMessages: ['Username or email already exists'] }, 409);
  }

  if (body.active) {
    try { await assertSeatAvailable(); } catch (e) { if (e instanceof SeatLimitError) return c.json(e.body(), 402); throw e; }
  }

  const policy = await checkPasswordPolicy(body.password);
  if (policy) return c.json({ errorMessages: [policy] }, 400);
  const passwordHash = await hashPassword(body.password);

  const [user] = await db
    .insert(schema.users)
    .values({
      username: body.username,
      email: body.email,
      displayName: body.displayName,
      passwordHash,
      active: body.active,
      avatarUrl: body.avatarUrl,
    })
    .returning();

  if (body.groups && body.groups.length > 0) {
    const groupRows = await db.select().from(schema.groups).where(inArray(schema.groups.name, body.groups));
    if (groupRows.length > 0) {
      await db.insert(schema.userGroups).values(groupRows.map((g) => ({ userId: user.id, groupId: g.id })));
    }
  }

  return c.json(
    {
      self: `/rest/api/2/user?username=${user.username}`,
      key: user.username,
      name: user.displayName,
      emailAddress: user.email,
      avatarUrls: user.avatarUrl ? { '48x48': user.avatarUrl } : {},
      active: user.active,
      timeZone: user.timezone,
    },
    201
  );
});

const updateUserSchema = z.object({
  username: z.string(),
  displayName: z.string().optional(),
  email: z.string().email().optional(),
  active: z.boolean().optional(),
  avatarUrl: z.string().max(2000).refine((v) => v === '' || /^https:\/\//i.test(v) || /^\/(?!\/)[^\\]*$/.test(v), 'A picture address starts with https:// or /').optional(),
  groups: z.array(z.string()).optional(),
});

app.put('/rest/api/2/user', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', updateUserSchema), async (c) => {
  const body = c.req.valid('json');

  const users = await db.select().from(schema.users).where(eq(schema.users.username, body.username)).limit(1);
  if (users.length === 0) return c.json({ errorMessages: ['User not found'] }, 404);
  const user = users[0];

  if (body.active === true && user.active === false) {
    try { await assertSeatAvailable(); } catch (e) { if (e instanceof SeatLimitError) return c.json(e.body(), 402); throw e; }
  }

  const updates: Record<string, unknown> = {};
  if (body.displayName !== undefined) updates.displayName = body.displayName;
  if (body.email !== undefined) updates.email = body.email;
  if (body.active !== undefined) updates.active = body.active;
  if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;
  updates.updatedAt = new Date();

  await db.update(schema.users).set(updates).where(eq(schema.users.id, user.id));

  if (body.groups !== undefined) {
    await db.delete(schema.userGroups).where(eq(schema.userGroups.userId, user.id));
    if (body.groups.length > 0) {
      const groupRows = await db.select().from(schema.groups).where(inArray(schema.groups.name, body.groups));
      if (groupRows.length > 0) {
        await db.insert(schema.userGroups).values(groupRows.map((g) => ({ userId: user.id, groupId: g.id })));
      }
    }
  }

  const updated = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
  const u = updated[0];

  return c.json({
    self: `/rest/api/2/user?username=${u.username}`,
    key: u.username,
    name: u.displayName,
    emailAddress: u.email,
    avatarUrls: u.avatarUrl ? { '48x48': u.avatarUrl } : {},
    active: u.active,
    timeZone: u.timezone,
  });
});

app.delete('/rest/api/2/user', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const username = c.req.query('username');
  if (!username) return c.json({ errorMessages: ['Username required'] }, 400);

  const users = await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
  if (users.length === 0) return c.json({ errorMessages: ['User not found'] }, 404);

  await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, users[0].id));
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Groups                                                             */
/* ------------------------------------------------------------------ */

const createGroupSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
});

app.post('/rest/api/2/group', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', createGroupSchema), async (c) => {
  const body = c.req.valid('json');
  const [group] = await db.insert(schema.groups).values({ name: body.name, description: body.description }).returning();
  return c.json({ id: String(group.id), name: group.name, description: group.description }, 201);
});

app.delete('/rest/api/2/group', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const groupName = c.req.query('groupname');
  if (!groupName) return c.json({ errorMessages: ['Group name required'] }, 400);

  const groups = await db.select().from(schema.groups).where(eq(schema.groups.name, groupName)).limit(1);
  if (groups.length === 0) return c.json({ errorMessages: ['Group not found'] }, 404);

  await db.delete(schema.groups).where(eq(schema.groups.id, groups[0].id));
  return c.json({});
});

const groupMemberSchema = z.object({
  groupname: z.string(),
  username: z.string(),
});

app.post('/rest/api/2/group/member', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', groupMemberSchema), async (c) => {
  const body = c.req.valid('json');

  const group = await db.select().from(schema.groups).where(eq(schema.groups.name, body.groupname)).limit(1);
  if (group.length === 0) return c.json({ errorMessages: ['Group not found'] }, 404);

  const user = await db.select().from(schema.users).where(eq(schema.users.username, body.username)).limit(1);
  if (user.length === 0) return c.json({ errorMessages: ['User not found'] }, 404);

  const existing = await db
    .select()
    .from(schema.userGroups)
    .where(and(eq(schema.userGroups.userId, user[0].id), eq(schema.userGroups.groupId, group[0].id)))
    .limit(1);

  if (existing.length > 0) return c.json({ errorMessages: ['User is already a member'] }, 409);

  await db.insert(schema.userGroups).values({ userId: user[0].id, groupId: group[0].id });
  return c.json({});
});

app.delete('/rest/api/2/group/member', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', groupMemberSchema), async (c) => {
  const body = c.req.valid('json');

  const group = await db.select().from(schema.groups).where(eq(schema.groups.name, body.groupname)).limit(1);
  if (group.length === 0) return c.json({ errorMessages: ['Group not found'] }, 404);

  const user = await db.select().from(schema.users).where(eq(schema.users.username, body.username)).limit(1);
  if (user.length === 0) return c.json({ errorMessages: ['User not found'] }, 404);

  await db
    .delete(schema.userGroups)
    .where(and(eq(schema.userGroups.userId, user[0].id), eq(schema.userGroups.groupId, group[0].id)));
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Permission Schemes                                                 */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/permissionscheme', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const schemes = await db.select().from(schema.permissionSchemes);

  let entries: (typeof schema.permissionEntries.$inferSelect)[] = [];
  if (schemes.length > 0) {
    entries = await db
      .select()
      .from(schema.permissionEntries)
      .where(inArray(schema.permissionEntries.schemeId, schemes.map((s) => s.id)));
  }

  const userIds = [...new Set(entries.map((e) => e.userId).filter(Boolean))];
  const groupIds = [...new Set(entries.map((e) => e.groupId).filter(Boolean))];
  const roleIds = [...new Set(entries.map((e) => e.projectRoleId).filter(Boolean))];

  const users = userIds.length > 0 ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds as number[])) : [];
  const groups = groupIds.length > 0 ? await db.select().from(schema.groups).where(inArray(schema.groups.id, groupIds as number[])) : [];
  const roles = roleIds.length > 0 ? await db.select().from(schema.projectRoles).where(inArray(schema.projectRoles.id, roleIds as number[])) : [];

  const userMap = new Map(users.map((u) => [u.id, u]));
  const groupMap = new Map(groups.map((g) => [g.id, g]));
  const roleMap = new Map(roles.map((r) => [r.id, r]));

  return c.json({
    permissionSchemes: schemes.map((s) => ({
      id: String(s.id),
      name: s.name,
      description: s.description,
      permissions: entries
        .filter((e) => e.schemeId === s.id)
        .map((e) => {
          let holder: { type: string; id: number; name: string } | null = null;
          if (e.anonymous) {
            holder = { type: 'anonymous', id: -1, name: 'Anyone' };
          } else if (e.anyUser) {
            holder = { type: 'anyUser', id: -2, name: 'Logged-in Users' };
          } else if (e.projectLead) {
            holder = { type: 'projectLead', id: -3, name: 'Project lead' };
          } else if (e.userId) {
            const u = userMap.get(e.userId);
            if (u) holder = { type: 'user', id: u.id, name: u.displayName || u.username };
          } else if (e.groupId) {
            const g = groupMap.get(e.groupId);
            if (g) holder = { type: 'group', id: g.id, name: g.name };
          } else if (e.projectRoleId) {
            const r = roleMap.get(e.projectRoleId);
            if (r) holder = { type: 'projectRole', id: r.id, name: r.name };
          }
          return {
            id: String(e.id),
            permission: e.permissionKey,
            holder,
          };
        }),
    })),
  });
});

const createPermissionSchemeSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  permissions: z
    .array(
      z.object({
        permission: z.string(),
        userId: z.number().optional(),
        groupId: z.number().optional(),
        projectRoleId: z.number().optional(),
        anyUser: z.boolean().optional(),
        projectLead: z.boolean().optional(),
        anonymous: z.boolean().optional(),
      })
    )
    .optional(),
});

app.post('/rest/api/2/permissionscheme', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', createPermissionSchemeSchema), async (c) => {
  const body = c.req.valid('json');

  const [scheme] = await db
    .insert(schema.permissionSchemes)
    .values({ name: body.name, description: body.description })
    .returning();

  if (body.permissions && body.permissions.length > 0) {
    await db.insert(schema.permissionEntries).values(
      body.permissions.map((p) => ({
        schemeId: scheme.id,
        permissionKey: p.permission,
        userId: p.userId || null,
        groupId: p.groupId || null,
        projectRoleId: p.projectRoleId || null,
        anyUser: p.anyUser ?? false,
        projectLead: p.projectLead ?? false,
        anonymous: p.anonymous ?? false,
      }))
    );
  }

  return c.json({ id: String(scheme.id), name: scheme.name, description: scheme.description }, 201);
});

// Creates a ready-to-use permission scheme where each project role (Viewers, Commenters, Developers, Administrators)
// has its own grants, creating the roles that do not exist yet. It only adds: nothing existing is changed.
app.post('/rest/api/2/permissionscheme/templates/role-based', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', z.object({ name: z.string().trim().min(1).max(255).default('Role-based scheme') }).strict()), async (c) => {
  const { name } = c.req.valid('json');
  const roles = await db.select().from(schema.projectRoles);
  const roleId = new Map(roles.map((r) => [r.name.toLowerCase(), r.id]));
  const created: string[] = [];
  for (const [roleName, def] of Object.entries(ROLE_TEMPLATE)) {
    if (!roleId.has(roleName.toLowerCase())) {
      const [r] = await db.insert(schema.projectRoles).values({ name: roleName, description: def.description }).returning();
      roleId.set(roleName.toLowerCase(), r.id);
      created.push(roleName);
    }
  }
  const [scheme] = await db.insert(schema.permissionSchemes).values({ name, description: 'Role-based: Viewers, Commenters, Developers, Administrators' }).returning();
  await db.insert(schema.permissionEntries).values(roleTemplateEntries().map((e) => ({ schemeId: scheme.id, permissionKey: e.permission, projectRoleId: roleId.get(e.roleName.toLowerCase())!, anyUser: false, anonymous: false })));
  return c.json({ id: String(scheme.id), name: scheme.name, rolesCreated: created }, 201);
});

const updatePermissionSchemeSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  permissions: z
    .array(
      z.object({
        id: z.number().optional(),
        permission: z.string(),
        userId: z.number().optional(),
        groupId: z.number().optional(),
        projectRoleId: z.number().optional(),
        anyUser: z.boolean().optional(),
        projectLead: z.boolean().optional(),
        anonymous: z.boolean().optional(),
      })
    )
    .optional(),
});

app.put('/rest/api/2/permissionscheme/:id', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', updatePermissionSchemeSchema), async (c) => {
  const id = Number(c.req.param('id'));
  const body = c.req.valid('json');

  const existing = await db.select().from(schema.permissionSchemes).where(eq(schema.permissionSchemes.id, id)).limit(1);
  if (existing.length === 0) return c.json({ errorMessages: ['Permission scheme not found'] }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;

  if (Object.keys(updates).length > 0) {
    await db.update(schema.permissionSchemes).set(updates).where(eq(schema.permissionSchemes.id, id));
  }

  if (body.permissions !== undefined) {
    await db.delete(schema.permissionEntries).where(eq(schema.permissionEntries.schemeId, id));
    if (body.permissions.length > 0) {
      await db.insert(schema.permissionEntries).values(
        body.permissions.map((p) => ({
          schemeId: id,
          permissionKey: p.permission,
          userId: p.userId || null,
          groupId: p.groupId || null,
          projectRoleId: p.projectRoleId || null,
          anyUser: p.anyUser ?? false,
          projectLead: p.projectLead ?? false,
          anonymous: p.anonymous ?? false,
        }))
      );
    }
  }

  return c.json({ id: String(id), name: body.name ?? existing[0].name, description: body.description ?? existing[0].description });
});

app.delete('/rest/api/2/permissionscheme/:id', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const id = Number(c.req.param('id'));

  const existing = await db.select().from(schema.permissionSchemes).where(eq(schema.permissionSchemes.id, id)).limit(1);
  if (existing.length === 0) return c.json({ errorMessages: ['Permission scheme not found'] }, 404);

  await db.delete(schema.permissionSchemes).where(eq(schema.permissionSchemes.id, id));
  return c.json({});
});

app.post('/rest/api/2/permissionscheme/:id/assign', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const projectId = Number(body.projectId);
  if (!projectId) return c.json({ errorMessages: ['projectId required'] }, 400);

  await db.delete(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, projectId));
  await db.insert(schema.permissionSchemeAssociations).values({ projectId, schemeId: id });
  return c.json({});
});

app.post('/rest/api/2/permissionscheme/:id/copy', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const existing = await db.select().from(schema.permissionSchemes).where(eq(schema.permissionSchemes.id, id)).limit(1);
  if (existing.length === 0) return c.json({ errorMessages: ['Permission scheme not found'] }, 404);

  const [scheme] = await db.insert(schema.permissionSchemes).values({
    name: body.name || `Copy of ${existing[0].name}`,
    description: body.description || existing[0].description,
  }).returning();

  const entries = await db.select().from(schema.permissionEntries).where(eq(schema.permissionEntries.schemeId, id));
  if (entries.length > 0) {
    await db.insert(schema.permissionEntries).values(
      entries.map((e) => ({
        schemeId: scheme.id,
        permissionKey: e.permissionKey,
        userId: e.userId,
        groupId: e.groupId,
        projectRoleId: e.projectRoleId,
        anyUser: e.anyUser,
        projectLead: e.projectLead,
        anonymous: e.anonymous,
      }))
    );
  }

  return c.json({ id: String(scheme.id), name: scheme.name, description: scheme.description }, 201);
});

/* ------------------------------------------------------------------ */
/*  Permissions & Roles                                                */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/role', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const roles = await db.select().from(schema.projectRoles);
  return c.json({
    roles: roles.map((r) => ({ id: r.id, name: r.name, description: r.description })),
  });
});

/* ------------------------------------------------------------------ */
/*  Server Info                                                        */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/serverInfo', async (c) => {
  let dbStatus = 'connected';
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    dbStatus = 'disconnected';
  }

  const issueCount = await db.select({ count: count() }).from(schema.issues);
  const projectCount = await db.select({ count: count() }).from(schema.projects);
  const userCount = await db.select({ count: count() }).from(schema.users);

  const signedIn = !!c.get('user');
  const base = {
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    version: VERSION,
    versionNumbers: VERSION_NUMBERS,
    deploymentType: 'Server',
    buildNumber: /^\d+$/.test(buildId()) ? Number(buildId()) : 0,
    build: buildId(),
    buildDate: process.env.VEQSIO_BUILD_DATE || null,
    serverTime: new Date().toISOString(),
    scmInfo: buildId(),
    serverTitle: (await publicBranding()).siteName,
  };
  // What somebody who is not signed in learns: the product, its version and the title. Uptime, the database state and how many
  // issues, projects and people there are belong to people who work here (they tell an attacker what to try and how big the prize is).
  // SERVERINFO_HIDE_VERSION=1 (public demo) also withholds the version from people who are not signed in.
  if (!signedIn) {
    const hideVersion = process.env.SERVERINFO_HIDE_VERSION === '1';
    return c.json({ baseUrl: base.baseUrl, ...(hideVersion ? {} : { version: base.version, versionNumbers: base.versionNumbers }), deploymentType: base.deploymentType, serverTime: base.serverTime, serverTitle: base.serverTitle });
  }
  return c.json({
    ...base,
    uptime: process.uptime(),
    startTime: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    dbStatus,
    stats: {
      issues: issueCount[0]?.count || 0,
      projects: projectCount[0]?.count || 0,
      users: userCount[0]?.count || 0,
    },
  });
});

app.post('/rest/api/2/admin/search/setup', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  try {
    await setupFullTextSearch();
    return c.json({ success: true, message: 'Full-text search indexes created' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ errorMessages: [`Failed to set up full-text search: ${message}`] }, 500);
  }
});

/* ------------------------------------------------------------------ */
/*  System Settings Helpers                                            */
/* ------------------------------------------------------------------ */

async function getSystemSetting(key: string): Promise<string | null> {
  try {
    const rows = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key));
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function setSystemSetting(key: string, value: string): Promise<void> {
  const existing = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key));
  if (existing.length > 0) {
    await db.update(schema.systemSettings).set({ value, updatedAt: new Date() }).where(eq(schema.systemSettings.id, existing[0].id));
  } else {
    await db.insert(schema.systemSettings).values({ key, value });
  }
}

/* ------------------------------------------------------------------ */
/*  General Configuration                                              */
/* ------------------------------------------------------------------ */

/** Attachment storage in use per project (bytes and files), for capacity planning. The files themselves live in the S3-compatible bucket. */
app.get('/rest/api/2/admin/system/storage', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const rows = await db.execute(sql`
    SELECT p.project_key AS key, p.name, count(a.id)::int AS files, COALESCE(sum(a.filesize), 0)::bigint AS bytes
    FROM projects p LEFT JOIN issues i ON i.project_id = p.id LEFT JOIN attachments a ON a.issue_id = i.id
    GROUP BY p.id ORDER BY COALESCE(sum(a.filesize), 0) DESC, p.project_key`) as unknown as Array<{ key: string; name: string; files: number; bytes: string | number }>;
  const quotaRows = await db.select({ k: schema.systemSettings.key, v: schema.systemSettings.value }).from(schema.systemSettings).where(like(schema.systemSettings.key, 'storage.quota.%'));
  const own = new Map(quotaRows.map((q) => [q.k.slice('storage.quota.'.length), Number(q.v)]));
  const instanceQuotaMb = Number((await getInstanceSettings()).attachmentProjectQuotaMb) || 0;
  const projects = rows.map((r) => ({ key: r.key, name: r.name, files: r.files, bytes: Number(r.bytes), quotaMb: own.has(r.key) ? own.get(r.key)! : instanceQuotaMb, ownQuota: own.has(r.key) }));
  return c.json({
    backend: process.env.STORAGE_TYPE || 'r2',
    maxFileSizeBytes: Number(process.env.STORAGE_MAX_FILE_SIZE) || 104857600,
    totalFiles: projects.reduce((a, p) => a + p.files, 0),
    totalBytes: projects.reduce((a, p) => a + p.bytes, 0),
    instanceQuotaMb,
    projects,
  });
});

app.get('/rest/api/2/admin/system/config', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const siteName = (await getSystemSetting('site_name')) || process.env.SITE_NAME || 'Veqsio';
  const baseUrl = (await getSystemSetting('base_url')) || process.env.BASE_URL || 'http://localhost:3000';
  const defaultLanguage = (await getSystemSetting('default_language')) || 'en';
  const dateFormat = (await getSystemSetting('date_format')) || 'YYYY-MM-DD';
  const timezone = (await getSystemSetting('timezone')) || 'UTC';

  return c.json({
    siteName,
    baseUrl,
    defaultLanguage,
    dateFormat,
    timezone,
  });
});

const updateSystemConfigSchema = z.object({
  siteName: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultLanguage: z.string().optional(),
  dateFormat: z.string().optional(),
  timezone: z.string().optional(),
});

app.put('/rest/api/2/admin/system/config', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', updateSystemConfigSchema), async (c) => {
  const body = c.req.valid('json');

  if (body.siteName !== undefined) await setSystemSetting('site_name', body.siteName);
  if (body.baseUrl !== undefined) await setSystemSetting('base_url', body.baseUrl);
  if (body.defaultLanguage !== undefined) await setSystemSetting('default_language', body.defaultLanguage);
  if (body.dateFormat !== undefined) await setSystemSetting('date_format', body.dateFormat);
  if (body.timezone !== undefined) await setSystemSetting('timezone', body.timezone);

  return c.json({ success: true });
});

/* ------------------------------------------------------------------ */
/*  Mail Server                                                        */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/system/mail', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const raw = await getSystemSetting('mail_config');
  const parsed = raw ? JSON.parse(raw) : {};
  const env = {
    host: process.env.SMTP_HOST || '',
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
    tls: process.env.SMTP_TLS === 'true',
  };

  return c.json({
    host: parsed.host ?? env.host,
    port: parsed.port ?? env.port,
    user: parsed.user ?? env.user,
    pass: parsed.pass ? '********' : env.pass ? '********' : '',
    from: parsed.from ?? env.from,
    tls: parsed.tls ?? env.tls,
  });
});

const updateMailConfigSchema = z.object({
  host: z.string(),
  port: z.number(),
  user: z.string(),
  pass: z.string(),
  from: z.string().email(),
  tls: z.boolean(),
});

app.put('/rest/api/2/admin/system/mail', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', updateMailConfigSchema), async (c) => {
  const body = c.req.valid('json');

  const raw = await getSystemSetting('mail_config');
  const existing = raw ? JSON.parse(raw) : {};

  const config = {
    ...existing,
    ...body,
  };

  await setSystemSetting('mail_config', JSON.stringify(config));

  return c.json({ success: true });
});

const testMailSchema = z.object({
  to: z.string().email(),
});

app.post('/rest/api/2/admin/system/mail/test', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', testMailSchema), async (c) => {
  const body = c.req.valid('json');

  const transport = await getTransporter();
  if (!transport) {
    return c.json({ errorMessages: ['SMTP not configured'] }, 400);
  }

  const config = await getSmtpConfig();

  try {
    await transport.sendMail({
      from: config?.from,
      to: body.to,
      subject: 'Veqsio SMTP Test',
      text: 'This is a test email from Veqsio. If you received this, your SMTP configuration is working correctly.',
      html: '<p>This is a test email from Veqsio. If you received this, your SMTP configuration is working correctly.</p>',
    });
    return c.json({ success: true, message: 'Test email sent' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ errorMessages: [`Failed to send test email: ${message}`] }, 500);
  }
});

export default app;
