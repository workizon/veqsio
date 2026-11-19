import { Hono } from 'hono'
import { requireAuth, type AppContext } from '../auth/middleware'
import { requireGlobalPermission } from '../rbac/middleware'
import { runHealthChecks, summarize } from '../admin/health-check'

const app = new Hono<AppContext>()

/** Configuration health check for administrators: finds misconfiguration before users run into it. */
app.get('/rest/api/2/admin/health-check', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  const checks = await runHealthChecks()
  return c.json({ generatedAt: new Date().toISOString(), ...summarize(checks), checks })
})

export default app
