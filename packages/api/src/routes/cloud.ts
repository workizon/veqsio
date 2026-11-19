/**
 * Tenant contract for the Veqsio Cloud control plane and the in-app cloud/update views.
 *   GET /rest/api/2/cloud/status    any signed-in user   plan, limits and (for administrators) usage
 *   GET /rest/api/2/cloud/tenant    METERING_TOKEN       usage + version + update settings, for the control plane
 *   GET /rest/api/2/admin/updates   SYSTEM_ADMIN         version/build, update-available badge and the update settings
 * The metering token is a shared secret (Authorization: Bearer <token> or X-Metering-Token). Without METERING_TOKEN
 * the machine endpoint does not exist (404).
 */
import { Hono } from 'hono';
import { count, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { hasGlobalPermission } from '../rbac/service';
import { isCloud } from '../cloud/mode';
import { tokenMatches } from '../cloud/token';
import { emailsSentLastHour, planLimits, storageUsage } from '../cloud/limits';
import { countActiveUsers, seatLimit } from '../license/seats';
import { getLicenseInfo } from '../license';
import { getInstanceSettings } from '../settings/instance';
import { updateStatus } from '../updates/releases';
import { VERSION, buildId } from '../version';

const app = new Hono<AppContext>();

async function usage() {
  const [u, st, em] = await Promise.all([countActiveUsers(), storageUsage(), emailsSentLastHour()]);
  const [{ issues }] = await db.select({ issues: count() }).from(schema.issues);
  const [{ projects }] = await db.select({ projects: count() }).from(schema.projects);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.users);
  const [{ levels }] = await db.select({ levels: count() }).from(schema.issueSecurityLevels); // any level makes list/search queries about 2.5x more expensive: the control plane sizes the workspace by it
  return { activeUsers: u, totalUsers: total, securityLevels: Number(levels), issues: Number(issues), projects: Number(projects), storageBytes: st.bytes, attachments: st.files, emailsLastHour: em };
}

function limitsView() {
  const l = planLimits();
  return { users: seatLimit(), storageBytes: l.storageBytes, attachmentMaxBytes: l.attachmentMaxBytes, emailsPerHour: l.emailsPerHour, apiRequestsPerMinute: l.apiRequestsPerMinute };
}

async function updateSettingsView() {
  const s = await getInstanceSettings();
  return { mode: s.autoUpdateMode, windowDay: s.autoUpdateWindowDay, windowHourUtc: s.autoUpdateWindowHour, notifyAdmins: s.autoUpdateNotifyAdmins };
}

app.get('/rest/api/2/cloud/status', requireAuth, async (c) => {
  const user = c.get('user');
  const lic = getLicenseInfo();
  return c.json({
    cloud: isCloud(),
    plan: lic.plan,
    limits: limitsView(),
    // usage numbers are for administrators only
    usage: user && (await hasGlobalPermission(user.id, 'SYSTEM_ADMIN')) ? await usage() : null,
  });
});

app.get('/rest/api/2/cloud/tenant', async (c) => {
  const expected = process.env.METERING_TOKEN;
  if (!expected) return c.json({ errorMessages: ['Not found'] }, 404);
  const auth = c.req.header('authorization') ?? '';
  const given = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : c.req.header('x-metering-token');
  if (!tokenMatches(given, expected)) return c.json({ errorMessages: ['Unauthorized'] }, 401);
  const lic = getLicenseInfo();
  c.header('Cache-Control', 'no-store');
  return c.json({
    generatedAt: new Date().toISOString(),
    instance: process.env.VEQSIO_INSTANCE_ID ?? null,
    version: VERSION, build: buildId(),
    plan: lic.plan, licenceState: lic.state,
    usage: await usage(),
    limits: limitsView(),
    updates: { settings: await updateSettingsView(), release: await updateStatus() },
  });
});

app.get('/rest/api/2/admin/updates', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  return c.json({ cloud: isCloud(), version: VERSION, build: buildId(), settings: await updateSettingsView(), release: await updateStatus() });
});

export default app;
