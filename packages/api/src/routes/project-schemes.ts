import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { requirePermission } from '../middleware/permissions';
import { db } from '../db';
import * as schema from '@veqsio/db';

/**
 * One place to see which configuration schemes a project uses (Jira's project settings overview). Project
 * admins can read it; changing a scheme is a global-configuration decision and needs SYSTEM_ADMIN, the same
 * as the assignment endpoints in the admin area. Issue security is read-only here: switching it needs a level
 * mapping, which the admin screen handles.
 */
const app = new Hono<AppContext>();
const P = '/rest/api/2/project/:key/schemes';

const KINDS = ['issuetype', 'workflow', 'permission', 'priority', 'security'] as const;
type Kind = (typeof KINDS)[number];

async function projectOf(key: string) {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
  return p;
}

const one = async <T>(q: Promise<T[]>) => (await q)[0] ?? null;

async function snapshot(projectId: number) {
  const named = <T extends { id: number; name: string }>(rows: T[]) => rows.map((r) => ({ id: r.id, name: r.name }));
  const [its, wfs, perms, prios, secs] = await Promise.all([
    db.select({ id: schema.issueTypeSchemes.id, name: schema.issueTypeSchemes.name }).from(schema.issueTypeSchemes),
    db.select({ id: schema.workflowSchemes.id, name: schema.workflowSchemes.name }).from(schema.workflowSchemes),
    db.select({ id: schema.permissionSchemes.id, name: schema.permissionSchemes.name }).from(schema.permissionSchemes),
    db.select({ id: schema.prioritySchemes.id, name: schema.prioritySchemes.name }).from(schema.prioritySchemes),
    db.select({ id: schema.issueSecuritySchemes.id, name: schema.issueSecuritySchemes.name }).from(schema.issueSecuritySchemes),
  ]);
  const cur = await Promise.all([
    one(db.select({ s: schema.issueTypeSchemeAssociations.schemeId }).from(schema.issueTypeSchemeAssociations).where(eq(schema.issueTypeSchemeAssociations.projectId, projectId)).limit(1)),
    one(db.select({ s: schema.workflowSchemeAssociations.schemeId }).from(schema.workflowSchemeAssociations).where(eq(schema.workflowSchemeAssociations.projectId, projectId)).limit(1)),
    one(db.select({ s: schema.permissionSchemeAssociations.schemeId }).from(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, projectId)).limit(1)),
    one(db.select({ s: schema.prioritySchemeAssociations.schemeId }).from(schema.prioritySchemeAssociations).where(eq(schema.prioritySchemeAssociations.projectId, projectId)).limit(1)),
    one(db.select({ s: schema.issueSecuritySchemeAssociations.schemeId }).from(schema.issueSecuritySchemeAssociations).where(eq(schema.issueSecuritySchemeAssociations.projectId, projectId)).limit(1)),
  ]);
  const fieldConfigs = await db.select({ t: schema.fieldConfigurationSchemeAssociations.issueTypeId }).from(schema.fieldConfigurationSchemeAssociations).where(eq(schema.fieldConfigurationSchemeAssociations.projectId, projectId));
  const lists = { issuetype: named(its), workflow: named(wfs), permission: named(perms), priority: named(prios), security: named(secs) };
  return {
    schemes: KINDS.map((kind, i) => ({
      kind,
      currentId: cur[i]?.s ?? null,
      current: lists[kind].find((o) => o.id === cur[i]?.s)?.name ?? null,
      options: lists[kind],
      /** false = shown only; change it in Administration */
      editable: kind !== 'security',
      /** true = "no scheme" is a valid choice (priority: all priorities) */
      optional: kind === 'priority',
    })),
    fieldConfigurationOverrides: fieldConfigs.length,
  };
}

app.get(P, requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectOf(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  return c.json(await snapshot(p.id));
});

app.put(P, requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), zValidator('json', z.object({
  kind: z.enum(['issuetype', 'workflow', 'permission', 'priority']),
  schemeId: z.number().int().positive().nullable(),
})), async (c) => {
  const p = await projectOf(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  const { kind, schemeId } = c.req.valid('json');
  if (schemeId === null && kind !== 'priority') return c.json({ errorMessages: ['A project must have a scheme of this kind'] }, 400);
  const table = { issuetype: schema.issueTypeSchemes, workflow: schema.workflowSchemes, permission: schema.permissionSchemes, priority: schema.prioritySchemes }[kind];
  if (schemeId !== null && !(await db.select({ id: table.id }).from(table).where(eq(table.id, schemeId)).limit(1)).length) return c.json({ errorMessages: ['Scheme not found'] }, 404);
  const assoc = { issuetype: schema.issueTypeSchemeAssociations, workflow: schema.workflowSchemeAssociations, permission: schema.permissionSchemeAssociations, priority: schema.prioritySchemeAssociations }[kind];
  await db.transaction(async (tx) => {
    await tx.delete(assoc).where(eq(assoc.projectId, p.id));
    if (schemeId !== null) await tx.insert(assoc).values({ projectId: p.id, schemeId });
  });
  return c.json(await snapshot(p.id));
});

export default app;
