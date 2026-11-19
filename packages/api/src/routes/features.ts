import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requirePermission } from '../middleware/permissions';
import { sessionMiddleware } from '../auth/middleware';
import { FEATURES, disabledFeatures, invalidateProjectFeatures, setFeatureEnabled } from '../features';

const app = new Hono<AppContext>();

/** Enabled flags for every signed-in user, so the UI can hide what is switched off. */
app.get('/rest/api/2/features', requireAuth, async (c) => {
  const off = await disabledFeatures();
  return c.json({ features: FEATURES.map((f) => ({ id: f.id, enabled: !off.has(f.id) })) });
});

app.get('/rest/api/2/admin/features', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const off = await disabledFeatures();
  return c.json({ features: FEATURES.map((f) => ({ id: f.id, name: f.name, description: f.description, note: f.note ?? null, enabled: !off.has(f.id) })) });
});

app.put('/rest/api/2/admin/features/:feature', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
  if (!body || typeof body.enabled !== 'boolean') return c.json({ errorMessages: ['enabled (boolean) is required'] }, 400);
  const id = c.req.param('feature');
  if (!(await setFeatureEnabled(id, body.enabled))) return c.json({ errorMessages: ['Feature not found'] }, 404);
  return c.json({ id, enabled: body.enabled });
});

app.use('/rest/api/2/project/*/features', sessionMiddleware);

/** Effective switches of one project: a feature is on when the instance allows it and the project has not turned it off. */
app.get('/rest/api/2/project/:key/features', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, c.req.param('key'))).limit(1);
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  const off = await disabledFeatures();
  return c.json({
    features: FEATURES.filter((f) => f.projectScoped).map((f) => ({
      id: f.id, name: f.name, description: f.description,
      instanceEnabled: !off.has(f.id), enabled: !off.has(f.id) && !p.disabledFeatures.includes(f.id),
    })),
  });
});

app.put('/rest/api/2/project/:key/features', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const body = await c.req.json().catch(() => null) as { features?: unknown } | null;
  const map = body?.features;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return c.json({ errorMessages: ['features must be an object of id: true|false'] }, 400);
  const scoped = new Set(FEATURES.filter((f) => f.projectScoped).map((f) => f.id));
  for (const [id, v] of Object.entries(map)) {
    if (!scoped.has(id)) return c.json({ errorMessages: [`Unknown project feature: ${id}`] }, 400);
    if (typeof v !== 'boolean') return c.json({ errorMessages: [`${id} must be true or false`] }, 400);
  }
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, c.req.param('key'))).limit(1);
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  const off = new Set(p.disabledFeatures);
  for (const [id, v] of Object.entries(map as Record<string, boolean>)) { if (v) off.delete(id); else off.add(id); }
  await db.update(schema.projects).set({ disabledFeatures: [...off], updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
  invalidateProjectFeatures();
  return c.json({ disabled: [...off] });
});

export default app;
