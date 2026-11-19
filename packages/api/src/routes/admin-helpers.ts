import { Hono } from 'hono'
import { requireAuth, type AppContext } from '../auth/middleware'
import { requireGlobalPermission } from '../rbac/middleware'
import { recordAudit } from '../audit/log'
import { explainNotification, explainPermission, HelperError, NOTIFICATION_EVENTS } from '../admin/helpers'

const app = new Hono<AppContext>()
const guard = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const

const positiveInt = (v: string | undefined): number | null => (v && /^\d{1,9}$/.test(v) ? Number(v) : null)

function fail(c: any, err: unknown) {
  if (err instanceof HelperError) return c.json({ errorMessages: [err.message] }, err.status)
  throw err
}

/** Why may (or may not) this user do this? Same evaluation code as the real permission check. */
app.get('/rest/api/2/admin/permission-helper', ...guard, async (c) => {
  const userId = positiveInt(c.req.query('userId'))
  const permission = (c.req.query('permission') || '').trim().toUpperCase()
  if (!userId) return c.json({ errorMessages: ['userId is required'] }, 400)
  if (!/^[A-Z_]{2,100}$/.test(permission)) return c.json({ errorMessages: ['permission is required, for example BROWSE_PROJECTS'] }, 400)
  try {
    const actor = c.get('user')!
    const result = await explainPermission({ userId, permission, projectKey: c.req.query('projectKey') || undefined, issueKey: c.req.query('issueKey') || undefined })
    if (result.user.id !== actor.id) {
      await recordAudit({
        actorId: actor.id, actorName: actor.username, action: 'PERMISSION_HELPER_LOOKUP', targetType: 'user', target: result.user.username,
        method: 'GET', path: c.req.path, status: 200,
        details: { permission, projectKey: result.scope.projectKey ?? null, issueKey: result.scope.issueKey ?? null },
      })
    }
    return c.json(result)
  } catch (err) { return fail(c, err) }
})

/** Would this user get an e-mail for this event on this issue, and why? */
app.get('/rest/api/2/admin/notification-helper', ...guard, async (c) => {
  const userId = positiveInt(c.req.query('userId'))
  const issueKey = (c.req.query('issueKey') || '').trim()
  const event = (c.req.query('event') || '').trim()
  const actorRaw = c.req.query('actorId')
  if (!userId || !issueKey || !event) return c.json({ errorMessages: ['issueKey, event and userId are required'] }, 400)
  const actorId = actorRaw ? positiveInt(actorRaw) : null
  if (actorRaw && !actorId) return c.json({ errorMessages: ['actorId must be a user id'] }, 400)
  try {
    const actor = c.get('user')!
    const result = await explainNotification({ issueKey, event, userId, actorId: actorId ?? undefined })
    if (result.user.id !== actor.id) {
      await recordAudit({
        actorId: actor.id, actorName: actor.username, action: 'NOTIFICATION_HELPER_LOOKUP', targetType: 'user', target: result.user.username,
        method: 'GET', path: c.req.path, status: 200, details: { event, issueKey },
      })
    }
    return c.json(result)
  } catch (err) { return fail(c, err) }
})

/** Events the notification helper understands. */
app.get('/rest/api/2/admin/notification-helper/events', ...guard, (c) => c.json({ events: NOTIFICATION_EVENTS }))

export default app
