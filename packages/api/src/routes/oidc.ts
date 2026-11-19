import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { asc, eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { featureRefusal, hasFeature, requireFeature } from '../license';
import { encryptSecret, SecretsConfigError } from '../auth/secrets';
import { oidcClient, OidcError, safeRedirectPath } from '../auth/oidc-client';
import { finishLogin, getEnabledProviderBySlug, OIDC_BIND_COOKIE, OidcLoginError, startLogin, type OidcProviderRow } from '../auth/oidc-service';

const app = new Hono<AppContext>();

const COOKIE_PATH = '/rest/auth/1/oidc';
const isProd = () => process.env.NODE_ENV === 'production';

function loginRedirect(code: string): string {
  return `/login?sso_error=${encodeURIComponent(code)}`;
}

/* ------------------------------------------------------------------ */
/*  Public: provider list for the login page                           */
/* ------------------------------------------------------------------ */

app.get('/rest/auth/1/oidc/providers', async (c) => {
  const rows = await db.select({ name: schema.oidcProviders.name, slug: schema.oidcProviders.slug })
    .from(schema.oidcProviders).where(eq(schema.oidcProviders.enabled, true)).orderBy(asc(schema.oidcProviders.name));
  c.header('Cache-Control', 'no-store');
  return c.json(rows);
});

/* ------------------------------------------------------------------ */
/*  Public: login flow                                                 */
/* ------------------------------------------------------------------ */

app.get('/rest/auth/1/oidc/:slug/login', async (c) => {
  const provider = await getEnabledProviderBySlug(c.req.param('slug'));
  if (!provider) return c.json({ errorMessages: ['Unknown identity provider'] }, 404);
  try {
    const { url, bindToken } = await startLogin(provider, {
      requestOrigin: new URL(c.req.url).origin,
      next: c.req.query('next'),
    });
    setCookie(c, OIDC_BIND_COOKIE, bindToken, {
      httpOnly: true, secure: isProd(), sameSite: 'Lax', path: COOKIE_PATH, maxAge: 600,
    });
    c.header('Cache-Control', 'no-store');
    return c.redirect(url, 302);
  } catch (err) {
    console.warn('OIDC login start failed', { slug: provider.slug, reason: err instanceof Error ? `${err.name}:${(err as any).code ?? ''}` : 'unknown' });
    return c.redirect(loginRedirect('sso_unavailable'), 302);
  }
});

app.get('/rest/auth/1/oidc/:slug/callback', async (c) => {
  const slug = c.req.param('slug');
  const bindToken = getCookie(c, OIDC_BIND_COOKIE);
  deleteCookie(c, OIDC_BIND_COOKIE, { path: COOKIE_PATH });
  c.header('Cache-Control', 'no-store');

  const provider = await getEnabledProviderBySlug(slug);
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!provider) return c.redirect(loginRedirect('unknown_provider'), 302);
  if (c.req.query('error')) return c.redirect(loginRedirect('idp_error'), 302);
  if (!code || !state || code.length > 4096 || state.length > 200) return c.redirect(loginRedirect('invalid_request'), 302);

  try {
    const result = await finishLogin(provider, { code, state, bindToken, requestOrigin: new URL(c.req.url).origin });
    setCookie(c, 'session', result.sessionId, {
      httpOnly: true, secure: isProd(), sameSite: 'Lax', path: '/', maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect(safeRedirectPath(result.next), 302);
  } catch (err) {
    const code2 = err instanceof OidcLoginError ? err.code : 'sso_failed';
    // Detail goes to the log (never tokens, codes or secrets); the browser only sees the short code.
    console.warn('OIDC login failed', { slug, code: code2, detail: err instanceof Error ? err.message : 'unknown' });
    return c.redirect(loginRedirect(code2), 302);
  }
});

/* ------------------------------------------------------------------ */
/*  Admin CRUD (system administrators only)                            */
/* ------------------------------------------------------------------ */

const admin = '/rest/api/2/admin/oidc';
app.use(admin, requireAuth, requireGlobalPermission('SYSTEM_ADMIN'));
app.use(`${admin}/*`, requireAuth, requireGlobalPermission('SYSTEM_ADMIN'));

const claimName = z.string().trim().regex(/^[A-Za-z0-9_:./-]{1,100}$/, 'Invalid claim name');
const domain = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, 'Invalid domain');
const issuerUrl = z.string().trim().max(500).url().refine((v) => {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || (u.protocol === 'http:' && !isProd() && process.env.OIDC_ALLOW_HTTP === 'true')) && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}, 'Issuer must be an https URL without credentials, query or fragment');

const providerFields = {
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Slug: 3-40 lowercase letters, digits or dashes'),
  issuer: issuerUrl,
  clientId: z.string().trim().min(1).max(500),
  scopes: z.string().trim().max(500).refine((s) => s.split(/\s+/).includes('openid'), 'Scopes must include openid'),
  emailClaim: claimName,
  nameClaim: claimName,
  groupsClaim: claimName.nullable(),
  allowedDomains: z.array(domain).max(100),
  autoProvision: z.boolean(),
  linkByEmail: z.boolean(),
  enforceSso: z.boolean(),
  enabled: z.boolean(),
};

const createSchema = z.object({
  name: providerFields.name,
  slug: providerFields.slug,
  issuer: providerFields.issuer,
  clientId: providerFields.clientId,
  clientSecret: z.string().min(1).max(2000),
  scopes: providerFields.scopes.default('openid profile email'),
  emailClaim: providerFields.emailClaim.default('email'),
  nameClaim: providerFields.nameClaim.default('name'),
  groupsClaim: providerFields.groupsClaim.default(null),
  allowedDomains: providerFields.allowedDomains.default([]),
  autoProvision: providerFields.autoProvision.default(false),
  linkByEmail: providerFields.linkByEmail.default(false),
  enforceSso: providerFields.enforceSso.default(false),
  enabled: providerFields.enabled.default(true),
}).strict();

const updateSchema = z.object({
  name: providerFields.name,
  issuer: providerFields.issuer,
  clientId: providerFields.clientId,
  clientSecret: z.string().min(1).max(2000), // omit to keep the stored secret
  scopes: providerFields.scopes,
  emailClaim: providerFields.emailClaim,
  nameClaim: providerFields.nameClaim,
  groupsClaim: providerFields.groupsClaim,
  allowedDomains: providerFields.allowedDomains,
  autoProvision: providerFields.autoProvision,
  linkByEmail: providerFields.linkByEmail,
  enforceSso: providerFields.enforceSso,
  enabled: providerFields.enabled,
}).partial().strict();

function present(row: OidcProviderRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    issuer: row.issuer,
    clientId: row.clientId,
    hasSecret: !!row.clientSecretEncrypted,
    scopes: row.scopes,
    emailClaim: row.emailClaim,
    nameClaim: row.nameClaim,
    groupsClaim: row.groupsClaim,
    allowedDomains: row.allowedDomains,
    autoProvision: row.autoProvision,
    linkByEmail: row.linkByEmail,
    enforceSso: row.enforceSso,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

function encrypt(secret: string): { value: string } | { error: Response } {
  try {
    return { value: encryptSecret(secret) };
  } catch (err) {
    if (err instanceof SecretsConfigError) {
      return { error: new Response(JSON.stringify({ errorMessages: ['SECRETS_ENCRYPTION_KEY is not configured on the server; refusing to store the client secret'] }), { status: 409, headers: { 'Content-Type': 'application/json' } }) };
    }
    throw err;
  }
}

app.get(admin, async (c) => {
  const rows = await db.select().from(schema.oidcProviders).orderBy(asc(schema.oidcProviders.id));
  return c.json(rows.map(present));
});

app.post(admin, requireFeature('sso_oidc_generic'), zValidator('json', createSchema), async (c) => {
  const body = c.req.valid('json');
  const enc = encrypt(body.clientSecret);
  if ('error' in enc) return enc.error;
  const [dupe] = await db.select({ id: schema.oidcProviders.id }).from(schema.oidcProviders).where(eq(schema.oidcProviders.slug, body.slug)).limit(1);
  if (dupe) return c.json({ errorMessages: ['A provider with this slug already exists'] }, 409);
  const { clientSecret: _s, ...rest } = body;
  const [row] = await db.insert(schema.oidcProviders).values({ ...rest, clientSecretEncrypted: enc.value }).returning();
  return c.json(present(row), 201);
});

app.get(`${admin}/:id{[0-9]+}`, async (c) => {
  const [row] = await db.select().from(schema.oidcProviders).where(eq(schema.oidcProviders.id, Number(c.req.param('id')))).limit(1);
  if (!row) return c.json({ errorMessages: ['Not found'] }, 404);
  return c.json(present(row));
});

app.put(`${admin}/:id{[0-9]+}`, zValidator('json', updateSchema), async (c) => {
  const id = Number(c.req.param('id'));
  const { clientSecret, ...rest } = c.req.valid('json');
  // Without a licence an existing provider can still be switched off, but not changed or switched on.
  const onlyDisabling = clientSecret === undefined && Object.keys(rest).length === 1 && rest.enabled === false;
  if (!hasFeature('sso_oidc_generic') && !onlyDisabling) return c.json(featureRefusal('sso_oidc_generic'), 402);
  const patch: Record<string, unknown> = { ...rest };
  if (clientSecret !== undefined) {
    const enc = encrypt(clientSecret);
    if ('error' in enc) return enc.error;
    patch.clientSecretEncrypted = enc.value;
  }
  if (Object.keys(patch).length === 0) return c.json({ errorMessages: ['Nothing to update'] }, 400);
  const [row] = await db.update(schema.oidcProviders).set(patch).where(eq(schema.oidcProviders.id, id)).returning();
  if (!row) return c.json({ errorMessages: ['Not found'] }, 404);
  oidcClient.clearCaches();
  return c.json(present(row));
});

app.delete(`${admin}/:id{[0-9]+}`, async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(schema.oidcProviders).where(eq(schema.oidcProviders.id, id)).returning({ id: schema.oidcProviders.id });
  if (!row) return c.json({ errorMessages: ['Not found'] }, 404);
  return c.body(null, 204);
});

/** Runs discovery against the configured issuer so admins can check their setup. */
app.post(`${admin}/:id{[0-9]+}/test`, requireFeature('sso_oidc_generic'), async (c) => {
  const [row] = await db.select().from(schema.oidcProviders).where(eq(schema.oidcProviders.id, Number(c.req.param('id')))).limit(1);
  if (!row) return c.json({ errorMessages: ['Not found'] }, 404);
  try {
    oidcClient.clearCaches();
    const doc = await oidcClient.discover(row.issuer);
    return c.json({ ok: true, authorizationEndpoint: doc.authorization_endpoint, jwksUri: doc.jwks_uri });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof OidcError ? err.message : 'Discovery failed' });
  }
});

export default app;
