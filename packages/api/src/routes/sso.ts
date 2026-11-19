import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { setCookie } from 'hono/cookie';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { initiateSSO, handleSSOCallback, getActiveSSOSettings } from '../auth/sso';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../auth/middleware';

const app = new Hono<AppContext>();

/* ------------------------------------------------------------------ */
/*  Public routes                                                      */
/* ------------------------------------------------------------------ */

app.get('/rest/auth/1/sso/microsoft', async (c) => {
  const settings = await getActiveSSOSettings();
  if (!settings) {
    return c.json({ errorMessages: ['SSO is not configured'] }, 400);
  }

  const { redirectUrl } = await initiateSSO(settings);
  return c.redirect(redirectUrl);
});

app.get('/rest/auth/1/sso/microsoft/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  const errorDescription = c.req.query('error_description');

  if (error) {
    console.warn(`[sso] provider returned an error: ${String(error).slice(0, 80)} ${String(errorDescription ?? '').slice(0, 200)}`);
    return c.json({ errorMessages: ['Microsoft sign-in was not completed'] }, 400);
  }

  if (!code || !state) {
    return c.json({ errorMessages: ['Missing authorization code or state'] }, 400);
  }

  const settings = await getActiveSSOSettings();
  if (!settings) {
    return c.json({ errorMessages: ['SSO is not configured'] }, 400);
  }

  try {
    const result = await handleSSOCallback(code, state, settings);
    setCookie(c, 'session', result.sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect('/dashboard');
  } catch (err) {
    console.error('SSO callback error:', err);
    const message = err instanceof Error ? err.message : 'SSO authentication failed';
    return c.json({ errorMessages: [message] }, 400);
  }
});

/* ------------------------------------------------------------------ */
/*  Admin routes                                                       */
/* ------------------------------------------------------------------ */

const ssoSettingsSchema = z.object({
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(500),
  tenantId: z.string().min(1).max(255),
  redirectUri: z.string().url().max(500),
  enforceSso: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
});

app.use('/rest/auth/1/sso/settings', sessionMiddleware);
app.use('/rest/auth/1/sso/settings', requireAuth);
app.use('/rest/auth/1/sso/settings', requireGlobalPermission('SYSTEM_ADMIN'));

app.get('/rest/auth/1/sso/settings', async (c) => {
  const rows = await db.select().from(schema.ssoSettings).limit(1);
  if (rows.length === 0) {
    return c.json({
      provider: 'microsoft',
      clientId: '',
      clientSecret: '',
      tenantId: '',
      redirectUri: '',
      enforceSso: false,
      active: true,
    });
  }
  const s = rows[0];
  return c.json({
    provider: s.provider,
    clientId: s.clientId,
    clientSecret: s.clientSecret,
    tenantId: s.tenantId,
    redirectUri: s.redirectUri,
    enforceSso: s.enforceSso,
    active: s.active,
  });
});

app.post('/rest/auth/1/sso/settings', zValidator('json', ssoSettingsSchema), async (c) => {
  try {
    const body = c.req.valid('json');

    const existing = await db.select().from(schema.ssoSettings).limit(1);

    if (existing.length > 0) {
      const [updated] = await db
        .update(schema.ssoSettings)
        .set({
          clientId: body.clientId,
          clientSecret: body.clientSecret,
          tenantId: body.tenantId,
          redirectUri: body.redirectUri,
          enforceSso: body.enforceSso,
          active: body.active,
          updatedAt: new Date(),
        })
        .where(eq(schema.ssoSettings.id, existing[0].id))
        .returning();
      return c.json({
        provider: updated.provider,
        clientId: updated.clientId,
        clientSecret: updated.clientSecret,
        tenantId: updated.tenantId,
        redirectUri: updated.redirectUri,
        enforceSso: updated.enforceSso,
        active: updated.active,
      });
    }

    const [created] = await db
      .insert(schema.ssoSettings)
      .values({
        provider: 'microsoft',
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        tenantId: body.tenantId,
        redirectUri: body.redirectUri,
        enforceSso: body.enforceSso,
        active: body.active,
      })
      .returning();

    return c.json(
      {
        provider: created.provider,
        clientId: created.clientId,
        clientSecret: created.clientSecret,
        tenantId: created.tenantId,
        redirectUri: created.redirectUri,
        enforceSso: created.enforceSso,
        active: created.active,
      },
      201
    );
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to save SSO settings'] }, 500);
  }
});

export default app;
