import { Hono } from 'hono';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { composePing, reportingEnabled, telemetryUrl } from '../telemetry/report';

const app = new Hono<AppContext>();

// What this instance reports, exactly as it would send it. Administrators can look before deciding.
app.get('/rest/api/2/admin/telemetry', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const state = await reportingEnabled();
  return c.json({ enabled: state.enabled, reason: state.reason, url: telemetryUrl(), frequency: 'about once a day', payload: await composePing() });
});

export default app;
