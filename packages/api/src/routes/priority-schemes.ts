import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';

const app = new Hono<AppContext>();
const admin = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const;
const P = '/rest/api/2/admin/priorityscheme';

const body = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  priorityIds: z.array(z.number().int()).min(1),
  defaultPriorityId: z.number().int().nullable().optional(),
  projectIds: z.array(z.number().int()).optional(),
});

async function validate(b: z.infer<typeof body>): Promise<string | null> {
  const ids = [...new Set(b.priorityIds)];
  const found = await db.select({ id: schema.priorities.id }).from(schema.priorities).where(inArray(schema.priorities.id, ids));
  if (found.length !== ids.length) return 'Unknown priority in the list';
  if (b.defaultPriorityId != null && !ids.includes(b.defaultPriorityId)) return 'The default priority must be one of the scheme\'s priorities';
  if (b.projectIds?.length) {
    const ps = await db.select({ id: schema.projects.id }).from(schema.projects).where(inArray(schema.projects.id, b.projectIds));
    if (ps.length !== new Set(b.projectIds).size) return 'Unknown project in the list';
  }
  return null;
}

/** Items and project assignment are replaced as a set; a project belongs to at most one scheme (the last one wins). */
async function write(id: number, b: z.infer<typeof body>) {
  await db.transaction(async (tx) => {
    await tx.update(schema.prioritySchemes).set({ name: b.name, description: b.description ?? null, defaultPriorityId: b.defaultPriorityId ?? null }).where(eq(schema.prioritySchemes.id, id));
    await tx.delete(schema.prioritySchemeItems).where(eq(schema.prioritySchemeItems.schemeId, id));
    await tx.insert(schema.prioritySchemeItems).values([...new Set(b.priorityIds)].map((priorityId) => ({ schemeId: id, priorityId })));
    if (b.projectIds) {
      await tx.delete(schema.prioritySchemeAssociations).where(eq(schema.prioritySchemeAssociations.schemeId, id));
      const ps = [...new Set(b.projectIds)];
      if (ps.length) {
        await tx.delete(schema.prioritySchemeAssociations).where(inArray(schema.prioritySchemeAssociations.projectId, ps));
        await tx.insert(schema.prioritySchemeAssociations).values(ps.map((projectId) => ({ projectId, schemeId: id })));
      }
    }
  });
}

app.get(P, ...admin, async (c) => {
  const schemes = await db.select().from(schema.prioritySchemes).orderBy(schema.prioritySchemes.id);
  const items = await db.select().from(schema.prioritySchemeItems);
  const assoc = await db.select({ projectId: schema.prioritySchemeAssociations.projectId, schemeId: schema.prioritySchemeAssociations.schemeId, name: schema.projects.name, key: schema.projects.projectKey })
    .from(schema.prioritySchemeAssociations).innerJoin(schema.projects, eq(schema.projects.id, schema.prioritySchemeAssociations.projectId));
  return c.json({
    schemes: schemes.map((s) => ({
      ...s,
      priorityIds: items.filter((i) => i.schemeId === s.id).map((i) => i.priorityId),
      projects: assoc.filter((a) => a.schemeId === s.id).map((a) => ({ id: a.projectId, key: a.key, name: a.name })),
    })),
  });
});

app.post(P, ...admin, zValidator('json', body), async (c) => {
  const b = c.req.valid('json');
  const err = await validate(b);
  if (err) return c.json({ errorMessages: [err] }, 400);
  const [s] = await db.insert(schema.prioritySchemes).values({ name: b.name }).returning();
  await write(s.id, b);
  return c.json({ id: s.id }, 201);
});

app.put(`${P}/:schemeId`, ...admin, zValidator('json', body), async (c) => {
  const id = Number(c.req.param('schemeId'));
  const [s] = Number.isInteger(id) ? await db.select().from(schema.prioritySchemes).where(eq(schema.prioritySchemes.id, id)).limit(1) : [];
  if (!s) return c.json({ errorMessages: ['Priority scheme not found'] }, 404);
  const b = c.req.valid('json');
  const err = await validate(b);
  if (err) return c.json({ errorMessages: [err] }, 400);
  await write(id, b);
  return c.json({ success: true });
});

app.delete(`${P}/:schemeId`, ...admin, async (c) => {
  const id = Number(c.req.param('schemeId'));
  const r = Number.isInteger(id) ? await db.delete(schema.prioritySchemes).where(eq(schema.prioritySchemes.id, id)).returning({ id: schema.prioritySchemes.id }) : [];
  if (!r.length) return c.json({ errorMessages: ['Priority scheme not found'] }, 404);
  return c.json({ success: true }); // its projects offer every priority again
});

export default app;
