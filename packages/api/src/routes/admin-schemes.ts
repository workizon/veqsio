import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, or, inArray, asc, desc, sql } from 'drizzle-orm';
import type { AppContext } from '../auth/middleware';
import { logWorkflowChange } from '../workflow/governance';
import { SYSTEM_SCREEN_FIELDS, SYSTEM_SCREEN_FIELD_KEYS } from '../workflow/screen-fields';

const app = new Hono<AppContext>();
console.log('[admin-schemes] module loaded, registering routes...');

app.get('/rest/api/2/admin/health', (c) => c.json({ ok: true }));

/* ------------------------------------------------------------------ */
/*  Issue Type Schemes                                                 */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/issuetypescheme', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const schemes = await db.select().from(schema.issueTypeSchemes);
  const items = schemes.length > 0
    ? await db.select().from(schema.issueTypeSchemeItems).where(inArray(schema.issueTypeSchemeItems.schemeId, schemes.map(s => s.id)))
    : [];
  const associations = schemes.length > 0
    ? await db.select().from(schema.issueTypeSchemeAssociations).where(inArray(schema.issueTypeSchemeAssociations.schemeId, schemes.map(s => s.id)))
    : [];

  const typeIds = [...new Set(items.map(i => i.issueTypeId))];
  const issueTypes = typeIds.length > 0
    ? await db.select().from(schema.issueTypes).where(inArray(schema.issueTypes.id, typeIds))
    : [];
  const typeMap = new Map(issueTypes.map(t => [t.id, t]));

  const projectIds = [...new Set(associations.map(a => a.projectId))];
  const projects = projectIds.length > 0
    ? await db.select().from(schema.projects).where(inArray(schema.projects.id, projectIds))
    : [];
  const projectMap = new Map(projects.map(p => [p.id, p]));

  return c.json({
    schemes: schemes.map(s => ({
      id: s.id,
      name: s.name,
      defaultIssueTypeId: s.defaultIssueTypeId,
      issueTypes: items
        .filter(i => i.schemeId === s.id)
        .map(i => typeMap.get(i.issueTypeId))
        .filter(Boolean)
        .map(t => ({ id: t!.id, name: t!.name, iconUrl: t!.iconUrl })),
      projects: associations
        .filter(a => a.schemeId === s.id)
        .map(a => ({ id: a.projectId, name: projectMap.get(a.projectId)?.name || 'Unknown' })),
    })),
  });
});

const issueTypeSchemeCreateSchema = z.object({
  name: z.string().min(1).max(255),
  defaultIssueTypeId: z.number().optional(),
  issueTypeIds: z.array(z.number()).default([]),
});

app.post('/rest/api/2/admin/issuetypescheme', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', issueTypeSchemeCreateSchema), async (c) => {
  const body = c.req.valid('json');
  const [scheme] = await db.insert(schema.issueTypeSchemes).values({
    name: body.name,
    defaultIssueTypeId: body.defaultIssueTypeId || null,
  }).returning();

  if (body.issueTypeIds.length > 0) {
    await db.insert(schema.issueTypeSchemeItems).values(
      body.issueTypeIds.map(id => ({ schemeId: scheme.id, issueTypeId: id }))
    );
  }

  return c.json({ id: scheme.id, name: scheme.name, defaultIssueTypeId: scheme.defaultIssueTypeId }, 201);
});

const issueTypeSchemeUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  defaultIssueTypeId: z.number().optional(),
  issueTypeIds: z.array(z.number()).optional(),
});

app.put('/rest/api/2/admin/issuetypescheme/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', issueTypeSchemeUpdateSchema), async (c) => {
  const id = Number(c.req.param('id'));
  const body = c.req.valid('json');

  const existing = await db.select().from(schema.issueTypeSchemes).where(eq(schema.issueTypeSchemes.id, id)).limit(1);
  if (existing.length === 0) return c.json({ errorMessages: ['Scheme not found'] }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.defaultIssueTypeId !== undefined) updates.defaultIssueTypeId = body.defaultIssueTypeId;
  if (Object.keys(updates).length > 0) {
    await db.update(schema.issueTypeSchemes).set(updates).where(eq(schema.issueTypeSchemes.id, id));
  }

  if (body.issueTypeIds !== undefined) {
    await db.delete(schema.issueTypeSchemeItems).where(eq(schema.issueTypeSchemeItems.schemeId, id));
    if (body.issueTypeIds.length > 0) {
      await db.insert(schema.issueTypeSchemeItems).values(
        body.issueTypeIds.map(issueTypeId => ({ schemeId: id, issueTypeId }))
      );
    }
  }

  return c.json({ id, name: body.name ?? existing[0].name });
});

app.delete('/rest/api/2/admin/issuetypescheme/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const id = Number(c.req.param('id'));
  await db.delete(schema.issueTypeSchemes).where(eq(schema.issueTypeSchemes.id, id));
  return c.json({});
});

app.post('/rest/api/2/admin/issuetypescheme/:id/assign', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const projectId = Number(body.projectId);
  if (!projectId) return c.json({ errorMessages: ['projectId required'] }, 400);

  await db.delete(schema.issueTypeSchemeAssociations).where(eq(schema.issueTypeSchemeAssociations.projectId, projectId));
  await db.insert(schema.issueTypeSchemeAssociations).values({ projectId, schemeId: id });
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Screens                                                            */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/screen', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const screens = await db.select().from(schema.screens);
  const tabs = screens.length > 0
    ? await db.select().from(schema.screenTabs).where(inArray(schema.screenTabs.screenId, screens.map(s => s.id))).orderBy(asc(schema.screenTabs.sortOrder))
    : [];
  const tabIds = tabs.map(t => t.id);
  const fields = tabIds.length > 0
    ? await db.select().from(schema.screenTabFields).where(inArray(schema.screenTabFields.tabId, tabIds)).orderBy(asc(schema.screenTabFields.sortOrder))
    : [];

  return c.json({
    screens: screens.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tabs: tabs
        .filter(t => t.screenId === s.id)
        .map(t => ({
          id: t.id,
          name: t.name,
          sortOrder: t.sortOrder,
          fields: fields.filter(f => f.tabId === t.id).map(f => ({
            id: f.id,
            fieldId: f.fieldId,
            isCustomField: f.isCustomField,
            fieldKey: f.fieldKey,
            required: f.required,
            sortOrder: f.sortOrder,
          })),
        })),
    })),
  });
});

app.post('/rest/api/2/admin/screen', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ name: z.string().min(1).max(255), description: z.string().optional() })), async (c) => {
  const body = c.req.valid('json');
  const [screen] = await db.insert(schema.screens).values(body).returning();
  return c.json({ id: screen.id, name: screen.name, description: screen.description }, 201);
});

app.put('/rest/api/2/admin/screen/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ name: z.string().min(1).max(255).optional(), description: z.string().optional() })), async (c) => {
  const id = Number(c.req.param('id'));
  const body = c.req.valid('json');
  const existing = await db.select().from(schema.screens).where(eq(schema.screens.id, id)).limit(1);
  if (existing.length === 0) return c.json({ errorMessages: ['Screen not found'] }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  await db.update(schema.screens).set(updates).where(eq(schema.screens.id, id));
  return c.json({ id, name: body.name ?? existing[0].name });
});

app.delete('/rest/api/2/admin/screen/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const id = Number(c.req.param('id'));
  await db.delete(schema.screens).where(eq(schema.screens.id, id));
  return c.json({});
});

// Screen tabs
app.post('/rest/api/2/admin/screen/:id/tab', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ name: z.string().min(1).max(100) })), async (c) => {
  const screenId = Number(c.req.param('id'));
  const body = c.req.valid('json');
  const maxOrder = await db.select({ max: sql<number>`COALESCE(MAX(sort_order), 0)` }).from(schema.screenTabs).where(eq(schema.screenTabs.screenId, screenId));
  const [tab] = await db.insert(schema.screenTabs).values({ screenId, name: body.name, sortOrder: (maxOrder[0]?.max || 0) + 1 }).returning();
  return c.json({ id: tab.id, name: tab.name, sortOrder: tab.sortOrder }, 201);
});

app.put('/rest/api/2/admin/screen/:screenId/tab/:tabId', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ name: z.string().min(1).max(100).optional(), sortOrder: z.number().optional() })), async (c) => {
  const tabId = Number(c.req.param('tabId'));
  const body = c.req.valid('json');
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;
  await db.update(schema.screenTabs).set(updates).where(eq(schema.screenTabs.id, tabId));
  return c.json({ id: tabId });
});

app.delete('/rest/api/2/admin/screen/:screenId/tab/:tabId', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const tabId = Number(c.req.param('tabId'));
  await db.delete(schema.screenTabs).where(eq(schema.screenTabs.id, tabId));
  return c.json({});
});

// Tab fields
/** Fields a screen can hold: the system fields a transition can collect plus every custom field. */
app.get('/rest/api/2/admin/screen-fields', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const customs = await db.select().from(schema.customFields).orderBy(asc(schema.customFields.name));
  return c.json({
    fields: [
      ...SYSTEM_SCREEN_FIELDS.map((f) => ({ key: f.key, name: f.name, custom: false, fieldId: 0, type: f.type })),
      ...customs.map((f) => ({ key: `customfield_${f.id}`, name: f.name, custom: true, fieldId: f.id, type: f.fieldType })),
    ],
  });
});

app.post('/rest/api/2/admin/screen/:screenId/tab/:tabId/field', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({
  fieldId: z.number().int().min(0).optional(),
  fieldKey: z.string().max(50).optional(),
  isCustomField: z.boolean().default(false),
  required: z.boolean().default(false),
})), async (c) => {
  const tabId = Number(c.req.param('tabId'));
  const screenId = Number(c.req.param('screenId'));
  const body = c.req.valid('json');
  let fieldId = body.fieldId ?? 0;
  let fieldKey: string | null = null;
  if (body.isCustomField) {
    const [cf] = await db.select({ id: schema.customFields.id }).from(schema.customFields).where(eq(schema.customFields.id, fieldId)).limit(1);
    if (!cf) return c.json({ errorMessages: ['Custom field not found'] }, 400);
  } else {
    if (!body.fieldKey || !SYSTEM_SCREEN_FIELD_KEYS.has(body.fieldKey)) return c.json({ errorMessages: [`fieldKey must be one of: ${[...SYSTEM_SCREEN_FIELD_KEYS].join(', ')}`] }, 400);
    fieldKey = body.fieldKey;
    fieldId = 0;
  }
  // A field appears once on a screen (across its tabs).
  const onScreen = await db.select({ f: schema.screenTabFields }).from(schema.screenTabFields)
    .innerJoin(schema.screenTabs, eq(schema.screenTabs.id, schema.screenTabFields.tabId)).where(eq(schema.screenTabs.screenId, screenId));
  if (onScreen.some((r) => (body.isCustomField ? r.f.isCustomField && r.f.fieldId === fieldId : !r.f.isCustomField && r.f.fieldKey === fieldKey))) {
    return c.json({ errorMessages: ['The field is already on this screen'] }, 409);
  }
  const maxOrder = await db.select({ max: sql<number>`COALESCE(MAX(sort_order), 0)` }).from(schema.screenTabFields).where(eq(schema.screenTabFields.tabId, tabId));
  const [field] = await db.insert(schema.screenTabFields).values({
    tabId,
    fieldId,
    fieldKey,
    required: body.required,
    isCustomField: body.isCustomField,
    sortOrder: (maxOrder[0]?.max || 0) + 1,
  }).returning();
  return c.json({ id: field.id, fieldId: field.fieldId, fieldKey: field.fieldKey, required: field.required, isCustomField: field.isCustomField }, 201);
});

app.put('/rest/api/2/admin/screen/:screenId/tab/:tabId/field/:fieldId', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ required: z.boolean() })), async (c) => {
  const fieldId = Number(c.req.param('fieldId'));
  const r = await db.update(schema.screenTabFields).set({ required: c.req.valid('json').required }).where(eq(schema.screenTabFields.id, fieldId)).returning({ id: schema.screenTabFields.id });
  if (!r.length) return c.json({ errorMessages: ['Field not found on the screen'] }, 404);
  return c.json({});
});

app.delete('/rest/api/2/admin/screen/:screenId/tab/:tabId/field/:fieldId', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const fieldId = Number(c.req.param('fieldId'));
  await db.delete(schema.screenTabFields).where(eq(schema.screenTabFields.id, fieldId));
  return c.json({});
});

app.put('/rest/api/2/admin/screen/:screenId/tab/:tabId/field/:fieldId/order', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ sortOrder: z.number() })), async (c) => {
  const fieldId = Number(c.req.param('fieldId'));
  const body = c.req.valid('json');
  await db.update(schema.screenTabFields).set({ sortOrder: body.sortOrder }).where(eq(schema.screenTabFields.id, fieldId));
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Field Configurations                                               */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/fieldconfiguration', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const configs = await db.select().from(schema.fieldConfigurations);
  const items = configs.length > 0
    ? await db.select().from(schema.fieldConfigurationItems).where(inArray(schema.fieldConfigurationItems.configId, configs.map(c => c.id)))
    : [];
  return c.json({
    configurations: configs.map(cf => ({
      id: cf.id,
      name: cf.name,
      description: cf.description,
      items: items.filter(i => i.configId === cf.id).map(i => ({
        id: i.id,
        fieldId: i.fieldId,
        isCustomField: i.isCustomField,
        isVisible: i.isVisible,
        isRequired: i.isRequired,
        renderer: i.renderer,
      })),
    })),
  });
});

app.post('/rest/api/2/admin/fieldconfiguration', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ name: z.string().min(1).max(255), description: z.string().optional() })), async (c) => {
  const body = c.req.valid('json');
  const [config] = await db.insert(schema.fieldConfigurations).values(body).returning();
  return c.json({ id: config.id, name: config.name, description: config.description }, 201);
});

app.put('/rest/api/2/admin/fieldconfiguration/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ name: z.string().min(1).max(255).optional(), description: z.string().optional(), items: z.array(z.object({ id: z.number().optional(), fieldId: z.number(), isCustomField: z.boolean().default(false), isVisible: z.boolean().default(true), isRequired: z.boolean().default(false), renderer: z.string().optional() })).optional() })), async (c) => {
  const id = Number(c.req.param('id'));
  const body = c.req.valid('json');
  const existing = await db.select().from(schema.fieldConfigurations).where(eq(schema.fieldConfigurations.id, id)).limit(1);
  if (existing.length === 0) return c.json({ errorMessages: ['Configuration not found'] }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (Object.keys(updates).length > 0) {
    await db.update(schema.fieldConfigurations).set(updates).where(eq(schema.fieldConfigurations.id, id));
  }

  if (body.items !== undefined) {
    await db.delete(schema.fieldConfigurationItems).where(eq(schema.fieldConfigurationItems.configId, id));
    if (body.items.length > 0) {
      await db.insert(schema.fieldConfigurationItems).values(
        body.items.map(i => ({
          configId: id,
          fieldId: i.fieldId,
          isCustomField: i.isCustomField,
          isVisible: i.isVisible,
          isRequired: i.isRequired,
          renderer: i.renderer || null,
        }))
      );
    }
  }

  return c.json({ id, name: body.name ?? existing[0].name });
});

app.delete('/rest/api/2/admin/fieldconfiguration/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const id = Number(c.req.param('id'));
  await db.delete(schema.fieldConfigurations).where(eq(schema.fieldConfigurations.id, id));
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Workflow Schemes                                                   */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/workflowscheme', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const schemes = await db.select().from(schema.workflowSchemes);
  const items = schemes.length > 0
    ? await db.select().from(schema.workflowSchemeItems).where(inArray(schema.workflowSchemeItems.schemeId, schemes.map(s => s.id)))
    : [];
  const associations = schemes.length > 0
    ? await db.select().from(schema.workflowSchemeAssociations).where(inArray(schema.workflowSchemeAssociations.schemeId, schemes.map(s => s.id)))
    : [];

  const wfIds = [...new Set(items.map(i => i.workflowId))];
  const workflows = wfIds.length > 0
    ? await db.select().from(schema.workflows).where(inArray(schema.workflows.id, wfIds))
    : [];
  const wfMap = new Map(workflows.map(w => [w.id, w]));

  const typeIds = [...new Set(items.map(i => i.issueTypeId))];
  const issueTypes = typeIds.length > 0
    ? await db.select().from(schema.issueTypes).where(inArray(schema.issueTypes.id, typeIds))
    : [];
  const typeMap = new Map(issueTypes.map(t => [t.id, t]));

  const projectIds = [...new Set(associations.map(a => a.projectId))];
  const projects = projectIds.length > 0
    ? await db.select().from(schema.projects).where(inArray(schema.projects.id, projectIds))
    : [];
  const projectMap = new Map(projects.map(p => [p.id, p]));

  return c.json({
    schemes: schemes.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      items: items
        .filter(i => i.schemeId === s.id)
        .map(i => ({
          issueTypeId: i.issueTypeId,
          issueTypeName: typeMap.get(i.issueTypeId)?.name || 'Unknown',
          workflowId: i.workflowId,
          workflowName: wfMap.get(i.workflowId)?.name || 'Unknown',
        })),
      projects: associations
        .filter(a => a.schemeId === s.id)
        .map(a => ({ id: a.projectId, name: projectMap.get(a.projectId)?.name || 'Unknown' })),
    })),
  });
});

app.post('/rest/api/2/admin/workflowscheme', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ name: z.string().min(1).max(255), description: z.string().optional(), items: z.array(z.object({ issueTypeId: z.number(), workflowId: z.number() })).default([]) })), async (c) => {
  const body = c.req.valid('json');
  const [scheme] = await db.insert(schema.workflowSchemes).values({ name: body.name, description: body.description }).returning();
  if (body.items.length > 0) {
    await db.insert(schema.workflowSchemeItems).values(
      body.items.map(i => ({ schemeId: scheme.id, issueTypeId: i.issueTypeId, workflowId: i.workflowId }))
    );
  }
  return c.json({ id: scheme.id, name: scheme.name }, 201);
});

app.put('/rest/api/2/admin/workflowscheme/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ name: z.string().min(1).max(255).optional(), description: z.string().optional(), items: z.array(z.object({ issueTypeId: z.number(), workflowId: z.number() })).optional() })), async (c) => {
  const id = Number(c.req.param('id'));
  const body = c.req.valid('json');
  const existing = await db.select().from(schema.workflowSchemes).where(eq(schema.workflowSchemes.id, id)).limit(1);
  if (existing.length === 0) return c.json({ errorMessages: ['Scheme not found'] }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (Object.keys(updates).length > 0) {
    await db.update(schema.workflowSchemes).set(updates).where(eq(schema.workflowSchemes.id, id));
  }

  if (body.items !== undefined) {
    await db.delete(schema.workflowSchemeItems).where(eq(schema.workflowSchemeItems.schemeId, id));
    if (body.items.length > 0) {
      await db.insert(schema.workflowSchemeItems).values(
        body.items.map(i => ({ schemeId: id, issueTypeId: i.issueTypeId, workflowId: i.workflowId }))
      );
    }
  }

  return c.json({ id, name: body.name ?? existing[0].name });
});

app.delete('/rest/api/2/admin/workflowscheme/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const id = Number(c.req.param('id'));
  await db.delete(schema.workflowSchemes).where(eq(schema.workflowSchemes.id, id));
  return c.json({});
});

app.post('/rest/api/2/admin/workflowscheme/:id/assign', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const projectId = Number(body.projectId);
  if (!projectId) return c.json({ errorMessages: ['projectId required'] }, 400);

  await db.delete(schema.workflowSchemeAssociations).where(eq(schema.workflowSchemeAssociations.projectId, projectId));
  await db.insert(schema.workflowSchemeAssociations).values({ projectId, schemeId: id });
  const [scheme] = await db.select({ name: schema.workflowSchemes.name }).from(schema.workflowSchemes).where(eq(schema.workflowSchemes.id, id)).limit(1);
  const [proj] = await db.select({ key: schema.projects.projectKey }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  const wfs = await db.select({ w: schema.workflowSchemeItems.workflowId }).from(schema.workflowSchemeItems).where(eq(schema.workflowSchemeItems.schemeId, id));
  for (const w of new Set(wfs.map((x) => x.w))) {
    await logWorkflowChange(w, c.get('user')?.id, { targetType: 'scheme', action: 'assigned', summary: `Workflow scheme "${scheme?.name ?? id}" assigned to project ${proj?.key ?? projectId}` });
  }
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Project Roles                                                      */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/projectrole', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const roles = await db.select().from(schema.projectRoles);
  const actors = roles.length > 0
    ? await db.select().from(schema.projectRoleActors).where(inArray(schema.projectRoleActors.roleId, roles.map(r => r.id)))
    : [];

  const userIds = [...new Set(actors.map(a => a.userId).filter(Boolean))];
  const users = userIds.length > 0
    ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds as number[]))
    : [];
  const userMap = new Map(users.map(u => [u.id, u]));

  const groupIds = [...new Set(actors.map(a => a.groupId).filter(Boolean))];
  const groups = groupIds.length > 0
    ? await db.select().from(schema.groups).where(inArray(schema.groups.id, groupIds as number[]))
    : [];
  const groupMap = new Map(groups.map(g => [g.id, g]));

  return c.json({
    roles: roles.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      actors: actors
        .filter(a => a.roleId === r.id)
        .map(a => ({
          id: a.id,
          projectId: a.projectId,
          type: a.userId ? 'user' : a.groupId ? 'group' : 'unknown',
          user: a.userId ? { id: a.userId, displayName: userMap.get(a.userId)?.displayName } : null,
          group: a.groupId ? { id: a.groupId, name: groupMap.get(a.groupId)?.name } : null,
        })),
    })),
  });
});

app.post('/rest/api/2/admin/projectrole', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ name: z.string().min(1).max(100), description: z.string().optional() })), async (c) => {
  const body = c.req.valid('json');
  const [role] = await db.insert(schema.projectRoles).values(body).returning();
  return c.json({ id: role.id, name: role.name, description: role.description }, 201);
});

app.put('/rest/api/2/admin/projectrole/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ name: z.string().min(1).max(100).optional(), description: z.string().optional() })), async (c) => {
  const id = Number(c.req.param('id'));
  const body = c.req.valid('json');
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  await db.update(schema.projectRoles).set(updates).where(eq(schema.projectRoles.id, id));
  return c.json({ id, name: body.name });
});

app.delete('/rest/api/2/admin/projectrole/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const id = Number(c.req.param('id'));
  await db.delete(schema.projectRoles).where(eq(schema.projectRoles.id, id));
  return c.json({});
});

app.post('/rest/api/2/admin/projectrole/:id/actor', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const roleId = Number(c.req.param('id'));
  const body = await c.req.json();
  const projectId = Number(body.projectId);
  const userId = body.userId ? Number(body.userId) : null;
  const groupId = body.groupId ? Number(body.groupId) : null;

  if (!projectId || (!userId && !groupId)) {
    return c.json({ errorMessages: ['projectId and userId or groupId required'] }, 400);
  }

  const [actor] = await db.insert(schema.projectRoleActors).values({ projectId, roleId, userId, groupId }).returning();
  return c.json({ id: actor.id, projectId, roleId, userId, groupId }, 201);
});

app.delete('/rest/api/2/admin/projectrole/:roleId/actor/:actorId', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const actorId = Number(c.req.param('actorId'));
  await db.delete(schema.projectRoleActors).where(eq(schema.projectRoleActors.id, actorId));
  return c.json({});
});

/* ------------------------------------------------------------------ */
/*  Custom Fields                                                      */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/customfield', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const fields = await db.select().from(schema.customFields);
  const contexts = fields.length > 0
    ? await db.select().from(schema.customFieldContexts).where(inArray(schema.customFieldContexts.customFieldId, fields.map(f => f.id)))
    : [];
  const options = contexts.length > 0
    ? await db.select().from(schema.customFieldOptions).where(inArray(schema.customFieldOptions.customFieldId, fields.map(f => f.id))).orderBy(asc(schema.customFieldOptions.sortOrder))
    : [];

  return c.json({
    customFields: fields.map(f => ({
      id: f.id,
      name: f.name,
      fieldType: f.fieldType,
      description: f.description,
      defaultValue: f.defaultValue,
      isGlobal: f.isGlobal,
      contexts: contexts.filter(ctx => ctx.customFieldId === f.id).map(ctx => ({
        id: ctx.id,
        projectId: ctx.projectId,
        issueTypeId: ctx.issueTypeId,
      })),
      options: options.filter(o => o.customFieldId === f.id).map(o => ({
        id: o.id,
        contextId: o.contextId,
        value: o.value,
        sortOrder: o.sortOrder,
        description: o.description,
        color: o.color,
        archived: o.archived,
      })),
    })),
  });
});

app.post('/rest/api/2/admin/customfield', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({
  name: z.string().min(1).max(255),
  fieldType: z.string().min(1).max(50),
  description: z.string().optional(),
  defaultValue: z.string().optional(),
  isGlobal: z.boolean().default(true),
})), async (c) => {
  const body = c.req.valid('json');
  const [field] = await db.insert(schema.customFields).values(body).returning();
  return c.json({ id: field.id, name: field.name, fieldType: field.fieldType }, 201);
});

app.put('/rest/api/2/admin/customfield/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  defaultValue: z.string().optional(),
  isGlobal: z.boolean().optional(),
})), async (c) => {
  const id = Number(c.req.param('id'));
  const body = c.req.valid('json');
  const existing = await db.select().from(schema.customFields).where(eq(schema.customFields.id, id)).limit(1);
  if (existing.length === 0) return c.json({ errorMessages: ['Custom field not found'] }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.defaultValue !== undefined) updates.defaultValue = body.defaultValue;
  if (body.isGlobal !== undefined) updates.isGlobal = body.isGlobal;
  await db.update(schema.customFields).set(updates).where(eq(schema.customFields.id, id));
  return c.json({ id, name: body.name ?? existing[0].name });
});

app.delete('/rest/api/2/admin/customfield/:id', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const id = Number(c.req.param('id'));
  await db.delete(schema.customFields).where(eq(schema.customFields.id, id));
  return c.json({});
});

// Custom field contexts
app.post('/rest/api/2/admin/customfield/:id/context', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ projectId: z.number().optional(), issueTypeId: z.number().optional() })), async (c) => {
  const customFieldId = Number(c.req.param('id'));
  const body = c.req.valid('json');
  const [ctx] = await db.insert(schema.customFieldContexts).values({ customFieldId, projectId: body.projectId || null, issueTypeId: body.issueTypeId || null }).returning();
  return c.json({ id: ctx.id, projectId: ctx.projectId, issueTypeId: ctx.issueTypeId }, 201);
});

app.delete('/rest/api/2/admin/customfield/:id/context/:contextId', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const contextId = Number(c.req.param('contextId'));
  await db.delete(schema.customFieldContexts).where(eq(schema.customFieldContexts.id, contextId));
  return c.json({});
});

// Custom field options
app.post('/rest/api/2/admin/customfield/:id/option', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({ contextId: z.number(), value: z.string().min(1).max(255), description: z.string().max(500).nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() })), async (c) => {
  const customFieldId = Number(c.req.param('id'));
  const body = c.req.valid('json');
  const maxOrder = await db.select({ max: sql<number>`COALESCE(MAX(sort_order), 0)` }).from(schema.customFieldOptions).where(eq(schema.customFieldOptions.customFieldId, customFieldId));
  const [opt] = await db.insert(schema.customFieldOptions).values({
    customFieldId,
    contextId: body.contextId,
    value: body.value,
    description: body.description ?? null,
    color: body.color ?? null,
    sortOrder: (maxOrder[0]?.max || 0) + 1,
  }).returning();
  return c.json({ id: opt.id, value: opt.value, sortOrder: opt.sortOrder }, 201);
});

// Edit a value: rename, describe, colour, archive or reorder. Renaming does not rewrite issues that already carry the old text.
app.put('/rest/api/2/admin/customfield/:id/option/:optionId', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({
  value: z.string().min(1).max(255).optional(),
  description: z.string().max(500).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  archived: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
}).strict()), async (c) => {
  const customFieldId = Number(c.req.param('id'));
  const optionId = Number(c.req.param('optionId'));
  const body = c.req.valid('json');
  const [opt] = await db.update(schema.customFieldOptions).set(body)
    .where(and(eq(schema.customFieldOptions.id, optionId), eq(schema.customFieldOptions.customFieldId, customFieldId))).returning();
  if (!opt) return c.json({ errorMessages: ['Option not found'] }, 404);
  return c.json({ id: opt.id, value: opt.value, description: opt.description, color: opt.color, archived: opt.archived, sortOrder: opt.sortOrder });
});

// A value that issues still carry is archived instead of deleted, so nothing silently loses its value.
app.delete('/rest/api/2/admin/customfield/:id/option/:optionId', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const customFieldId = Number(c.req.param('id'));
  const optionId = Number(c.req.param('optionId'));
  const [opt] = await db.select().from(schema.customFieldOptions)
    .where(and(eq(schema.customFieldOptions.id, optionId), eq(schema.customFieldOptions.customFieldId, customFieldId))).limit(1);
  if (!opt) return c.json({ errorMessages: ['Option not found'] }, 404);
  const [used] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.customFieldValues)
    .where(and(eq(schema.customFieldValues.customFieldId, customFieldId), or(eq(schema.customFieldValues.stringValue, opt.value), eq(schema.customFieldValues.textValue, opt.value))));
  if (Number(used?.n) > 0) {
    await db.update(schema.customFieldOptions).set({ archived: true }).where(eq(schema.customFieldOptions.id, optionId));
    return c.json({ archived: true, usedBy: Number(used.n) });
  }
  await db.delete(schema.customFieldOptions).where(eq(schema.customFieldOptions.id, optionId));
  return c.json({ deleted: true });
});

/* ------------------------------------------------------------------ */
/*  Audit Log                                                          */
/* ------------------------------------------------------------------ */

app.get('/rest/api/2/admin/auditlog', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const userFilter = c.req.query('user');
  const actionFilter = c.req.query('action');
  const fromDate = c.req.query('from');
  const toDate = c.req.query('to');

  // Use webhook_deliveries as a proxy for system events; fallback to empty
  const deliveries = await db.select().from(schema.webhookDeliveries).orderBy(desc(schema.webhookDeliveries.createdAt)).limit(500);

  const userIds = [...new Set(deliveries.map(d => d.webhookId).filter(Boolean))];
  const webhooks = userIds.length > 0
    ? await db.select().from(schema.webhooks).where(inArray(schema.webhooks.id, userIds as number[]))
    : [];
  const whMap = new Map(webhooks.map(w => [w.id, w]));

  let logs = deliveries.map(d => ({
    id: d.id,
    timestamp: d.createdAt,
    user: 'System',
    action: d.success ? 'WEBHOOK_DELIVERED' : 'WEBHOOK_FAILED',
    entity: 'Webhook',
    details: `Event: ${d.event} | ${d.responseStatus ? `Status ${d.responseStatus}` : 'No response'}`,
  }));

  if (userFilter) {
    logs = logs.filter(l => l.user.toLowerCase().includes(userFilter.toLowerCase()));
  }
  if (actionFilter) {
    logs = logs.filter(l => l.action.toLowerCase().includes(actionFilter.toLowerCase()));
  }
  if (fromDate) {
    const from = new Date(fromDate || '');
    logs = logs.filter(l => l.timestamp && l.timestamp >= from);
  }
  if (toDate) {
    const to = new Date(toDate || '');
    logs = logs.filter(l => l.timestamp && l.timestamp <= to);
  }

  return c.json({ logs });
});

export default app;
