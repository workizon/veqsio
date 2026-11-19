import { createMiddleware } from 'hono/factory'
import type { AppContext } from '../auth/middleware'
import { getInstanceSettings } from '../settings/instance'
import { hasGlobalPermission } from '../rbac/service'

/**
 * Maintenance mode (Administration → Settings → Maintenance): everybody except system administrators gets a 503 with the message,
 * so that an upgrade or a restore is not disturbed by people working. What must keep working: the health check and metrics (the
 * load balancer and monitoring), the public settings (the sign-in page shows the message), and signing in and out (an
 * administrator has to be able to get in).
 */
const ALWAYS = [
  /^\/health(\/|$)/, /^\/metrics$/, /^\/ready$/,
  /^\/rest\/api\/2\/settings\/public$/, /^\/rest\/api\/2\/serverInfo$/,
  /^\/rest\/auth\/1\/session(\/|$)/, /^\/rest\/auth\/1\/(sso|oidc|saml)(\/|$)/, /^\/auth\//,
]

export function maintenanceAllows(path: string): boolean { return ALWAYS.some((re) => re.test(path)) }

export function maintenanceMode() {
  return createMiddleware<AppContext>(async (c, next) => {
    const path = c.req.path
    if (maintenanceAllows(path)) return next()
    const s = await getInstanceSettings()
    if (!s.maintenanceEnabled) return next()
    const user = c.get('user')
    if (user && (user.username === 'admin' || (await hasGlobalPermission(user.id, 'SYSTEM_ADMIN')))) return next()
    c.header('Retry-After', '300')
    return c.json({ maintenance: true, errorMessages: [String(s.maintenanceMessage || 'Veqsio is being maintained and will be back shortly.')] }, 503)
  })
}
