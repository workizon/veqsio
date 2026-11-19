import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { sessionMiddleware, requireAuth, type AppContext } from '../auth/middleware'
import { requireGlobalPermission } from '../rbac/middleware'
import { getLicenseInfo, installLicenseKey, removeLicenseKey } from '../license'
import { keyStatusOf, licenseAdminView } from '../license/admin'

const app = new Hono<AppContext>()
app.use('/rest/api/2/admin/license*', sessionMiddleware)
app.use('/rest/api/2/license*', sessionMiddleware)

/** The key itself is never returned; only what it grants. */
const publicView = () => licenseAdminView()

// Any signed-in user may ask what the instance is licensed for (the UI hides gated entries).
app.get('/rest/api/2/license/status', requireAuth, (c) => {
  const l = getLicenseInfo()
  return c.json({ state: l.state, plan: l.plan, features: l.features, expiresAt: l.expiresAt })
})

app.get('/rest/api/2/admin/license', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => c.json(await publicView()))

app.put(
  '/rest/api/2/admin/license',
  requireAuth,
  requireGlobalPermission('SYSTEM_ADMIN'),
  zValidator('json', z.object({ key: z.string().min(10).max(8192) }).strict()),
  async (c) => {
    const info = await installLicenseKey(c.req.valid('json').key)
    if (info.state === 'invalid' || info.state === 'none') return c.json({ errorMessages: [info.message], keyStatus: keyStatusOf(info) }, 400)
    return c.json(await publicView())
  },
)

app.delete('/rest/api/2/admin/license', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  await removeLicenseKey()
  return c.json(await publicView())
})

export default app
