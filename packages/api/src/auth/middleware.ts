import type { MiddlewareHandler } from 'hono';
import { getSession } from './session';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, isNull } from 'drizzle-orm';
import { getCookie } from 'hono/cookie';
import { createHash } from 'crypto';
import { resolvePluginPrincipal, PLUGIN_TOKEN_PREFIX } from '../plugins/auth';
import { resolveRunPrincipal, RUN_TOKEN_PREFIX, getAgentByUserId, type RunPrincipal } from '../agents/auth';
import { isAgentUsername } from '../agents/logic';

export type AppContext = {
  Variables: {
    user: typeof schema.users.$inferSelect | null;
    /** Scopes of the personal access token that authenticated this request; null for cookie sessions. */
    tokenScopes?: string[] | null;
    /** Set once the credential has been resolved, so route-level re-mounts of sessionMiddleware are no-ops. */
    sessionResolved?: boolean;
    /** Set when the request was authenticated with a short-lived agent run token: the run it is confined to. */
    agentRun?: RunPrincipal['run'] | null;
  };
};

export const sessionMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  // The app mounts this globally and many route files mount it again; resolve the credential only once per request.
  if (c.get('sessionResolved')) return next();
  let user: typeof schema.users.$inferSelect | null = null;
  let tokenScopes: string[] | null = null;

  // Check Bearer token first
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token.startsWith(PLUGIN_TOKEN_PREFIX)) {
      // Plugin tokens: service-user principal limited to granted scopes; never falls back to a cookie session.
      const principal = await resolvePluginPrincipal(token);
      c.set('user', principal?.user ?? null);
      c.set('tokenScopes', principal ? principal.scopes : null);
      return next();
    }
    if (token.startsWith(RUN_TOKEN_PREFIX)) {
      // Agent run tokens: the agent's user, confined to one run's issue/project by the tokenScopes middleware.
      const principal = await resolveRunPrincipal(token);
      c.set('user', principal?.user ?? null);
      c.set('tokenScopes', principal ? ['run'] : null);
      c.set('agentRun', principal?.run ?? null);
      c.set('sessionResolved', true);
      return next();
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [pat] = await db.select().from(schema.personalAccessTokens).where(
      and(
        eq(schema.personalAccessTokens.tokenHash, tokenHash),
        isNull(schema.personalAccessTokens.revokedAt),
      )
    );
    if (pat) {
      if (pat.expiresAt && new Date(pat.expiresAt) < new Date()) {
        return c.json({ errorMessages: ['Token expired'] }, 401);
      }
      // Update lastUsedAt
      await db.update(schema.personalAccessTokens).set({ lastUsedAt: new Date() }).where(eq(schema.personalAccessTokens.id, pat.id));
      // Fetch user
      const users = await db.select().from(schema.users).where(eq(schema.users.id, pat.userId)).limit(1);
      if (users.length > 0) {
        user = users[0];
        tokenScopes = Array.isArray(pat.scopes) ? (pat.scopes as string[]) : [];
      }
    }
  }

  // Agents authenticate with tokens only, and only while enabled (defence in depth: they have no password).
  if (user && isAgentUsername(user.username)) {
    const agent = await getAgentByUserId(user.id);
    if (!agent || !agent.enabled) { user = null; tokenScopes = null; }
  }

  // Fall back to session cookie
  if (!user) {
    const sessionId = getCookie(c, 'session');
    if (sessionId) {
      const session = await getSession(sessionId);
      if (session) {
        const users = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
        if (users.length > 0 && !isAgentUsername(users[0].username)) {
          user = users[0]; // agents never have cookie sessions
        }
      }
    }
  }

  // Deactivated users (SCIM, admin) never authenticate, whatever credential they still hold.
  if (user && user.active === false) {
    user = null;
    tokenScopes = null;
  }

  c.set('user', user);
  c.set('tokenScopes', tokenScopes);
  c.set('sessionResolved', true);
  await next();
};

export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ errorMessages: ['Unauthorized'] }, 401);
  }
  await next();
};
