import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { exportConfig, importConfig } from '../settings/config-io';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import { SETTINGS, getInstanceSettings, updateInstanceSettings } from '../settings/instance';
import { featureRefusal, hasFeature } from '../license';
import { isCloud } from '../cloud/mode';

const app = new Hono<AppContext>();

/** Public on purpose: only what the sign-in page and every page header need (the announcement and the password rule). */
app.get('/rest/api/2/settings/public', async (c) => {
  const s = await getInstanceSettings();
  const [lang] = await db.select({ v: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'default_language')).limit(1).catch(() => []);
  return c.json({
    defaultLanguage: lang?.v || 'en',
    maintenance: s.maintenanceEnabled ? { message: String(s.maintenanceMessage || '') } : null,
    announcement: s.announcementEnabled && s.announcementMessage ? { level: s.announcementLevel, message: s.announcementMessage } : null,
    passwordMinLength: s.passwordMinLength,
    publicProjects: !!s.publicProjectsEnabled,
    issueTerm: s.issueTerm,
    // managed tenant: the UI hides self-host-only pages (the API refuses them regardless)
    cloud: isCloud(),
    // public demo (VEQSIO_DEMO=1): the UI shows a countdown to the next scheduled reset
    demo: process.env.VEQSIO_DEMO === '1' ? { resetEveryMinutes: Number(process.env.DEMO_RESET_MINUTES) || 60 } : null,
  });
});

app.get('/rest/api/2/admin/settings', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const values = await getInstanceSettings();
  return c.json({ settings: SETTINGS.map((d) => ({ ...d, value: values[d.key] })) });
});

app.put('/rest/api/2/admin/settings', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ errorMessages: ['A JSON object of settings is required'] }, 400);
  // keeping the audit log for a limited time is an Enterprise feature; turning it back to 0 (keep everything) is always allowed
  const days = (body as Record<string, unknown>).auditRetentionDays;
  if (typeof days === 'number' && days > 0 && !hasFeature('audit_retention')) return c.json(featureRefusal('audit_retention'), 402);
  const res = await updateInstanceSettings(body as Record<string, unknown>);
  if (!res.ok) return c.json({ errorMessages: res.errors }, 400);
  return c.json({ success: true });
});

// Configuration as code: one JSON document with instance settings, switches and per-project configuration.
app.get('/rest/api/2/admin/config/export', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  c.header('Content-Disposition', 'attachment; filename="veqsio-config.json"');
  return c.json(await exportConfig());
});

app.post('/rest/api/2/admin/config/import', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const doc = await c.req.json().catch(() => null);
  const report = await importConfig(doc, c.req.query('dryRun') === 'true');
  return c.json(report, report.errors.length ? 400 : 200);
});

export default app;
