import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { isPluginUser } from '../plugins/auth';
import { PLUGIN_SCOPES, UI_LOCATIONS, validateManifest, allowInsecurePluginHosts, type PluginManifest } from '../plugins/manifest';
import { assertPublicUrl, fetchManifest, PluginFetchError } from '../plugins/ssrf';
import { fetchCatalog } from '../plugins/catalog';
import {
  PluginError, applyUpdate, disablePlugin, enablePlugin, getPlugin, getSettingsForPlugin, getSettingsView, installPlugin,
  previewUpdate, publicView, putSettings, rotateSigningSecret, rotateToken, uninstallPlugin,
} from '../plugins/service';

const app = new Hono<AppContext>();
const BASE = '/rest/api/2/admin/plugins';

/** System administrators only; plugin principals are refused outright (defence in depth on top of token scopes). */
const adminOnly = [
  requireAuth,
  createMiddleware<AppContext>(async (c, next) => {
    if (isPluginUser(c.get('user'))) return c.json({ errorMessages: ['Plugins cannot call administration endpoints'] }, 403);
    await next();
  }),
  requireGlobalPermission('ADMINISTER'),
] as const;

app.onError((err, c) => {
  if (err instanceof PluginError) return c.json({ errorMessages: [err.message], ...(err.details ? { details: err.details } : {}) }, err.status);
  if (err instanceof PluginFetchError) return c.json({ errorMessages: [err.message] }, 400);
  throw err;
});

const idParam = (c: { req: { param: (k: string) => string } }) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw new PluginError(404, 'Plugin not found');
  return id;
};

const sourceSchema = z.union([
  z.object({ url: z.string().url().max(2048) }).strict(),
  z.object({ manifest: z.record(z.unknown()) }).strict(),
]);

async function resolveManifest(src: z.infer<typeof sourceSchema>): Promise<PluginManifest> {
  const res = 'url' in src ? await fetchManifest(src.url) : validateManifest(src.manifest, { allowInsecure: allowInsecurePluginHosts() });
  if (!res.ok) throw new PluginError(400, 'Invalid plugin manifest', res.errors);
  return res.manifest;
}

/* ---- Marketplace: a catalog of manifest URLs the administrator points the instance at ---- */
const CATALOG_SETTING = 'plugin_catalog_url';
const getCatalogUrl = async () => (await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, CATALOG_SETTING)).limit(1))[0]?.value ?? '';

app.get(`${BASE}/catalog`, ...adminOnly, async (c) => {
  const url = await getCatalogUrl();
  if (!url) return c.json({ url: '', entries: [], skipped: 0, installed: [] });
  const cat = await fetchCatalog(url);
  const installed = (await db.select({ key: schema.plugins.key }).from(schema.plugins)).map((p) => p.key);
  return c.json({ url, ...cat, installed });
});

app.put(`${BASE}/catalog`, ...adminOnly, zValidator('json', z.object({ url: z.string().max(2048) }).strict()), async (c) => {
  const url = c.req.valid('json').url.trim();
  if (url) await assertPublicUrl(url); // same guard as manifests: https, no private or metadata addresses
  const [row] = await db.select({ id: schema.systemSettings.id }).from(schema.systemSettings).where(eq(schema.systemSettings.key, CATALOG_SETTING)).limit(1);
  if (row) await db.update(schema.systemSettings).set({ value: url, updatedAt: new Date() }).where(eq(schema.systemSettings.id, row.id));
  else await db.insert(schema.systemSettings).values({ key: CATALOG_SETTING, value: url });
  return c.json({ url });
});

// Scope catalogue for the UI
app.get(`${BASE}/scopes`, ...adminOnly, (c) => c.json({ scopes: PLUGIN_SCOPES }));

app.get(BASE, ...adminOnly, async (c) => {
  const rows = await db.select().from(schema.plugins).orderBy(schema.plugins.name);
  return c.json(rows.map(publicView));
});

app.post(BASE, ...adminOnly, zValidator('json', sourceSchema), async (c) => {
  const manifest = await resolveManifest(c.req.valid('json'));
  const { plugin, signingSecret } = await installPlugin(manifest, c.get('user')!.id);
  // The signing secret is shown exactly once; it is stored encrypted and only used to sign deliveries.
  return c.json({ ...publicView(plugin), signingSecret }, 201);
});

app.get(`${BASE}/:id`, ...adminOnly, async (c) => c.json(publicView(await getPlugin(idParam(c)))));

const enableSchema = z.object({ grantScopes: z.array(z.enum(PLUGIN_SCOPES as [string, ...string[]])).max(PLUGIN_SCOPES.length).optional() }).strict();
app.post(`${BASE}/:id/enable`, ...adminOnly, zValidator('json', enableSchema), async (c) => {
  const { plugin, token } = await enablePlugin(idParam(c), c.req.valid('json').grantScopes);
  return c.json({ ...publicView(plugin), token }); // token is non-null only when first minted; shown once
});

app.post(`${BASE}/:id/disable`, ...adminOnly, async (c) => c.json(publicView(await disablePlugin(idParam(c)))));

const updateSchema = z.object({
  url: z.string().url().max(2048).optional(),
  manifest: z.record(z.unknown()).optional(),
  confirm: z.boolean().default(false),
  approveScopes: z.array(z.string()).max(PLUGIN_SCOPES.length).default([]),
}).strict().refine((b) => (b.url === undefined) !== (b.manifest === undefined), 'Provide exactly one of url or manifest');
app.put(`${BASE}/:id`, ...adminOnly, zValidator('json', updateSchema), async (c) => {
  const body = c.req.valid('json');
  const p = await getPlugin(idParam(c));
  const next = await resolveManifest(body.url !== undefined ? { url: body.url } : { manifest: body.manifest! });
  const diff = previewUpdate(p, next);
  if (!body.confirm) return c.json({ applied: false, diff }); // preview: shows scope/event diff, changes nothing
  const { plugin } = await applyUpdate(p, next, body.approveScopes);
  return c.json({ applied: true, diff, plugin: publicView(plugin) });
});

app.delete(`${BASE}/:id`, ...adminOnly, async (c) => {
  await uninstallPlugin(idParam(c));
  return c.body(null, 204);
});

app.post(`${BASE}/:id/token`, ...adminOnly, async (c) => c.json({ token: await rotateToken(idParam(c)) }));
app.post(`${BASE}/:id/signing-secret`, ...adminOnly, async (c) => c.json({ signingSecret: await rotateSigningSecret(idParam(c)) }));

app.get(`${BASE}/:id/settings`, ...adminOnly, async (c) => c.json(await getSettingsView(await getPlugin(idParam(c)))));
const settingsSchema = z.object({ values: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])) }).strict();
app.put(`${BASE}/:id/settings`, ...adminOnly, zValidator('json', settingsSchema), async (c) => {
  const p = await getPlugin(idParam(c));
  await putSettings(p, c.req.valid('json').values);
  return c.json(await getSettingsView(p));
});

app.get(`${BASE}/:id/deliveries`, ...adminOnly, async (c) => {
  const id = idParam(c);
  await getPlugin(id);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const rows = await db.select().from(schema.pluginDeliveries).where(eq(schema.pluginDeliveries.pluginId, id))
    .orderBy(desc(schema.pluginDeliveries.createdAt), desc(schema.pluginDeliveries.id)).limit(limit);
  return c.json(rows);
});

/* ---------------------- non-admin endpoints ---------------------- */

// UI panels for a location (any authenticated user). The web app builds the iframe URL from baseUrl + path.
app.get('/rest/api/2/plugins/panels', requireAuth, async (c) => {
  const location = c.req.query('location');
  if (!location || !(UI_LOCATIONS as readonly string[]).includes(location)) return c.json({ errorMessages: ['location is required'] }, 400);
  const rows = await db.select().from(schema.plugins).where(eq(schema.plugins.enabled, true));
  const panels = rows.flatMap((p) => {
    const m = p.manifest as PluginManifest;
    return m.uiPanels
      .filter((panel) => panel.location === location)
      .map((panel) => ({ pluginKey: p.key, pluginName: p.name, location: panel.location, title: panel.title, url: m.baseUrl.replace(/\/+$/, '') + panel.path }));
  });
  return c.json(panels);
});

// A plugin reads its own configuration (including secrets) with its token. Nobody else can.
app.get('/rest/api/2/plugins/self/settings', requireAuth, async (c) => {
  const user = c.get('user')!;
  if (!isPluginUser(user)) return c.json({ errorMessages: ['Only plugins can read their own settings'] }, 403);
  const [p] = await db.select().from(schema.plugins).where(eq(schema.plugins.serviceUserId, user.id)).limit(1);
  if (!p || !p.enabled) return c.json({ errorMessages: ['Unauthorized'] }, 401);
  return c.json(await getSettingsForPlugin(p));
});

export default app;
