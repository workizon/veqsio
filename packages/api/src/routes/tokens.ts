import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createHash, randomBytes } from 'crypto'
import { eq, and, isNull } from 'drizzle-orm'
import { db } from '../db'
import { personalAccessTokens } from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { VALID_SCOPES } from '../middleware/token-scopes'

const tokenRoute = new Hono<AppContext>()

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function generateToken() {
  return 'veqsio_' + randomBytes(32).toString('hex')
}

function envDays(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** Expiry policy: default 90 days, at most 365 (override with PAT_DEFAULT_EXPIRY_DAYS / PAT_MAX_EXPIRY_DAYS). */
export function expiryPolicy() {
  const max = envDays('PAT_MAX_EXPIRY_DAYS', 365)
  const def = Math.min(envDays('PAT_DEFAULT_EXPIRY_DAYS', 90), max)
  return { defaultDays: def, maxDays: max }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(255).default('Personal Access Token'),
  scopes: z.array(z.enum(VALID_SCOPES)).min(1).max(VALID_SCOPES.length).default(['*']),
  expiresInDays: z.number().int().min(1).optional(),
}).strict()

// Policy and scope catalogue for the UI
tokenRoute.get('/rest/api/2/mypersonalaccessTokens/policy', requireAuth, (c) => {
  return c.json({ ...expiryPolicy(), scopes: VALID_SCOPES })
})

// List tokens (without hash)
tokenRoute.get('/rest/api/2/mypersonalaccessTokens', requireAuth, async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ errorMessages: ['Unauthorized'] }, 401)

  const tokens = await db.select({
    id: personalAccessTokens.id,
    name: personalAccessTokens.name,
    scopes: personalAccessTokens.scopes,
    createdAt: personalAccessTokens.createdAt,
    lastUsedAt: personalAccessTokens.lastUsedAt,
    expiresAt: personalAccessTokens.expiresAt,
    revokedAt: personalAccessTokens.revokedAt,
  }).from(personalAccessTokens).where(
    and(eq(personalAccessTokens.userId, user.id), isNull(personalAccessTokens.revokedAt))
  )
  return c.json(tokens)
})

// Create token
tokenRoute.post('/rest/api/2/mypersonalaccessTokens', requireAuth, zValidator('json', createSchema), async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ errorMessages: ['Unauthorized'] }, 401)

  const body = c.req.valid('json')
  const policy = expiryPolicy()
  const days = body.expiresInDays ?? policy.defaultDays
  if (days > policy.maxDays) {
    return c.json({ errorMessages: [`Tokens may be valid for at most ${policy.maxDays} days`] }, 400)
  }
  // A token can never mint a more powerful token than itself.
  // A token that is itself scoped (not the unrestricted '*' and not the 'admin' scope) creates no token at all: whatever it asked for,
  // the new one would be a way to get past the limits of the old one ('admin' counts as unrestricted for the scope check).
  const callerScopes = c.get('tokenScopes')
  if (callerScopes && !callerScopes.includes('*') && !callerScopes.includes('admin')) {
    return c.json({ errorMessages: ['A scoped token cannot create tokens'] }, 403)
  }
  if (callerScopes && !callerScopes.includes('*') && body.scopes.includes('*')) {
    return c.json({ errorMessages: ['This token cannot create an unrestricted token'] }, 403)
  }
  const scopes = [...new Set(body.scopes)]
  const plainToken = generateToken()
  const expiresAt = new Date(Date.now() + days * 86400000)

  const [token] = await db.insert(personalAccessTokens).values({
    userId: user.id,
    name: body.name,
    tokenHash: hashToken(plainToken),
    scopes,
    expiresAt,
  }).returning({ id: personalAccessTokens.id })

  return c.json({ id: token.id, token: plainToken, name: body.name, scopes, expiresAt }, 201)
})

// Revoke token
tokenRoute.delete('/rest/api/2/mypersonalaccessTokens/:id', requireAuth, async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ errorMessages: ['Unauthorized'] }, 401)

  const id = parseInt(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ errorMessages: ['Invalid id'] }, 400)
  await db.update(personalAccessTokens).set({ revokedAt: new Date() }).where(
    and(eq(personalAccessTokens.id, id), eq(personalAccessTokens.userId, user.id))
  )
  return c.json({ success: true })
})

export default tokenRoute
