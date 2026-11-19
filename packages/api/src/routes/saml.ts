import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createPrivateKey } from 'node:crypto';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { asc, eq } from 'drizzle-orm';
import { generateServiceProviderMetadata } from '@node-saml/node-saml';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { featureRefusal, hasFeature, requireFeature } from '../license';
import { decryptSecret, encryptSecret, SecretsConfigError } from '../auth/secrets';
import { safeRedirectPath } from '../auth/oidc-client';
import { getClientIP, isAllowed } from '../middleware/rate-limit';
import { recordAudit } from '../audit/log';
import {
  finishLogin, getEnabledSamlProviderBySlug, NAMEID_FORMATS, SAML_BIND_COOKIE, SamlLoginError, samlEndpoints, startLogin, type SamlProviderRow,
} from '../auth/saml-service';
import { buildAuthnRequestUrl, describeCertificate } from '../auth/saml-validator';
import { spConfigFor } from '../auth/saml-service';
import { MAX_SAML_RESPONSE_B64, splitPemCertificates } from '../auth/saml-xml';

const app = new Hono<AppContext>();

const COOKIE_PATH = '/rest/auth/1/saml';
const isProd = () => process.env.NODE_ENV === 'production';
/** Largest accepted ACS request body: the base64 response plus form overhead. */
const MAX_ACS_BODY = MAX_SAML_RESPONSE_B64 + 8 * 1024;

const envInt = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};

function loginRedirect(code: string): string {
  return `/login?sso_error=${encodeURIComponent(code)}`;
}

async function limited(c: any, bucket: string, max: number): Promise<boolean> {
  const res = await isAllowed(`veqsio:ratelimit:saml-${bucket}:${getClientIP(c)}`, { maxRequests: envInt('RATE_LIMIT_AUTH_MAX', max), windowMs: 60_000 });
  if (!res.allowed) c.header('Retry-After', String(res.retryAfter));
  return !res.allowed;
}

/** Reads a request body as text, refusing to buffer more than `limit` bytes (also for chunked bodies). */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------------ */
/*  Public: provider list for the login page                           */
/* ------------------------------------------------------------------ */

app.get('/rest/auth/1/saml/providers', async (c) => {
  const rows = await db.select({ name: schema.samlProviders.name, slug: schema.samlProviders.slug })
    .from(schema.samlProviders).where(eq(schema.samlProviders.enabled, true)).orderBy(asc(schema.samlProviders.name));
  c.header('Cache-Control', 'no-store');
  return c.json(rows);
});

/* ------------------------------------------------------------------ */
/*  Public: login flow                                                 */
/* ------------------------------------------------------------------ */

app.get('/rest/auth/1/saml/:slug/login', async (c) => {
  if (await limited(c, 'login', 60)) return c.redirect(loginRedirect('rate_limited'), 302);
  const provider = await getEnabledSamlProviderBySlug(c.req.param('slug'));
  if (!provider) return c.json({ errorMessages: ['Unknown identity provider'] }, 404);
  try {
    const { url, bindToken } = await startLogin(provider, { requestOrigin: new URL(c.req.url).origin, next: c.req.query('next') });
    // The ACS request is a cross-site POST from the IdP, so the binding cookie must be SameSite=None there (HTTPS only).
    setCookie(c, SAML_BIND_COOKIE, bindToken, {
      httpOnly: true, secure: isProd(), sameSite: isProd() ? 'None' : 'Lax', path: COOKIE_PATH, maxAge: 600,
    });
    c.header('Cache-Control', 'no-store');
    return c.redirect(url, 302);
  } catch (err) {
    console.warn('SAML login start failed', { slug: provider.slug, reason: err instanceof Error ? `${err.name}:${(err as any).code ?? ''}` : 'unknown' });
    return c.redirect(loginRedirect('sso_unavailable'), 302);
  }
});

app.post('/rest/auth/1/saml/:slug/acs', async (c) => {
  const slug = c.req.param('slug');
  const bindToken = getCookie(c, SAML_BIND_COOKIE);
  deleteCookie(c, SAML_BIND_COOKIE, { path: COOKIE_PATH });
  c.header('Cache-Control', 'no-store');
  const ip = getClientIP(c);
  const audit = (action: string, extra: { actorId?: number; actorName?: string; code?: string }) =>
    recordAudit({ action, targetType: 'sso', target: `saml:${slug}`, actorId: extra.actorId ?? null, actorName: extra.actorName ?? null, method: 'POST', path: `/rest/auth/1/saml/${slug}/acs`, ip, details: extra.code ? { code: extra.code } : null });

  if (await limited(c, 'acs', 30)) return c.redirect(loginRedirect('rate_limited'), 303);

  const ct = (c.req.header('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/x-www-form-urlencoded')) return c.redirect(loginRedirect('invalid_request'), 303);
  const text = await readCapped(c.req.raw, MAX_ACS_BODY);
  if (text === null) return c.json({ errorMessages: ['Request body too large'] }, 413);
  const form = new URLSearchParams(text);
  const samlResponse = form.get('SAMLResponse');
  const relayState = form.get('RelayState');

  const provider = await getEnabledSamlProviderBySlug(slug);
  if (!provider) return c.redirect(loginRedirect('unknown_provider'), 303);
  if (!samlResponse || !relayState || relayState.length > 200) return c.redirect(loginRedirect('invalid_request'), 303);

  try {
    const result = await finishLogin(provider, { samlResponse, relayState, bindToken, requestOrigin: new URL(c.req.url).origin });
    setCookie(c, 'session', result.sessionId, { httpOnly: true, secure: isProd(), sameSite: 'Lax', path: '/', maxAge: 30 * 24 * 60 * 60 });
    void audit('SAML_LOGIN', { actorId: result.userId, actorName: result.username });
    return c.redirect(safeRedirectPath(result.next), 303);
  } catch (err) {
    const code = err instanceof SamlLoginError ? err.code : 'sso_failed';
    // The detail goes to the log (never the response or assertion); the browser only sees the short code.
    console.warn('SAML login failed', { slug, code, detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
    void audit('SAML_LOGIN_FAILED', { code });
    return c.redirect(loginRedirect(code), 303);
  }
});

app.get('/rest/auth/1/saml/:slug/metadata', async (c) => {
  const [row] = await db.select().from(schema.samlProviders).where(eq(schema.samlProviders.slug, c.req.param('slug'))).limit(1);
  if (!row) return c.json({ errorMessages: ['Unknown identity provider'] }, 404);
  const ep = samlEndpoints(row.slug, new URL(c.req.url).origin);
  const cert = row.signRequests ? row.spSigningCertificate : null;
  const xml = generateServiceProviderMetadata({
    issuer: ep.entityId,
    callbackUrl: ep.acsUrl,
    identifierFormat: row.nameIdFormat,
    wantAssertionsSigned: false,
    publicCerts: cert ? [cert] : null,
    ...(cert && row.spSigningKeyEncrypted ? { privateKey: decryptSecret(row.spSigningKeyEncrypted) } : {}),
  });
  return c.body(xml, 200, { 'Content-Type': 'application/samlmetadata+xml; charset=utf-8', 'Cache-Control': 'no-cache' });
});

/* ------------------------------------------------------------------ */
/*  Admin CRUD (system administrators only)                            */
/* ------------------------------------------------------------------ */

const admin = '/rest/api/2/admin/saml';
app.use(admin, requireAuth, requireGlobalPermission('SYSTEM_ADMIN'));
app.use(`${admin}/*`, requireAuth, requireGlobalPermission('SYSTEM_ADMIN'));

const attrName = z.string().trim().min(1).max(300);
const domain = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, 'Invalid domain');
const httpsUrl = z.string().trim().max(1000).url().refine((v) => {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || (u.protocol === 'http:' && !isProd())) && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}, 'Must be an https URL without credentials or fragment');
const certBundle = z.string().trim().min(1).max(40_000).refine((v) => {
  const blocks = splitPemCertificates(v);
  return blocks.length > 0 && blocks.length <= 5 && blocks.every((b) => describeCertificate(b) !== null);
}, 'Paste one to five valid PEM certificates (-----BEGIN CERTIFICATE-----)');
const privateKeyPem = z.string().trim().max(20_000).refine((v) => {
  try { createPrivateKey(v); return true; } catch { return false; }
}, 'Not a valid PEM private key');
const singleCert = z.string().trim().max(10_000).refine((v) => { const b = splitPemCertificates(v); return b.length === 1 && describeCertificate(b[0]) !== null; }, 'Not a valid PEM certificate');

const fields = {
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Slug: 3-40 lowercase letters, digits or dashes'),
  idpEntityId: z.string().trim().min(1).max(500),
  idpSsoUrl: httpsUrl,
  idpCertificates: certBundle,
  signRequests: z.boolean(),
  spSigningKey: privateKeyPem,
  spSigningCertificate: singleCert,
  nameIdFormat: z.enum(NAMEID_FORMATS),
  emailAttribute: attrName.nullable(),
  displayNameAttribute: attrName.nullable(),
  usernameAttribute: attrName.nullable(),
  groupsAttribute: attrName.nullable(),
  syncGroups: z.boolean(),
  defaultGroups: z.array(z.string().trim().min(1).max(255)).max(50),
  allowedDomains: z.array(domain).max(100),
  autoProvision: z.boolean(),
  linkByEmail: z.boolean(),
  enforceSso: z.boolean(),
  enabled: z.boolean(),
};

const createSchema = z.object({
  name: fields.name,
  slug: fields.slug,
  idpEntityId: fields.idpEntityId,
  idpSsoUrl: fields.idpSsoUrl,
  idpCertificates: fields.idpCertificates,
  signRequests: fields.signRequests.default(false),
  spSigningKey: fields.spSigningKey.optional(),
  spSigningCertificate: fields.spSigningCertificate.optional(),
  nameIdFormat: fields.nameIdFormat.default(NAMEID_FORMATS[0]),
  emailAttribute: fields.emailAttribute.default(null),
  displayNameAttribute: fields.displayNameAttribute.default(null),
  usernameAttribute: fields.usernameAttribute.default(null),
  groupsAttribute: fields.groupsAttribute.default(null),
  syncGroups: fields.syncGroups.default(false),
  defaultGroups: fields.defaultGroups.default([]),
  allowedDomains: fields.allowedDomains.default([]),
  autoProvision: fields.autoProvision.default(false),
  linkByEmail: fields.linkByEmail.default(false),
  enforceSso: fields.enforceSso.default(false),
  enabled: fields.enabled.default(true),
}).strict();

const updateSchema = z.object({ ...Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'slug')) } as Omit<typeof fields, 'slug'>).partial().strict();

function present(row: SamlProviderRow, origin: string) {
  const ep = samlEndpoints(row.slug, origin);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    idpEntityId: row.idpEntityId,
    idpSsoUrl: row.idpSsoUrl,
    idpCertificates: row.idpCertificates,
    certificates: splitPemCertificates(row.idpCertificates).map(describeCertificate),
    signRequests: row.signRequests,
    hasSigningKey: !!row.spSigningKeyEncrypted,
    spSigningCertificate: row.spSigningCertificate,
    nameIdFormat: row.nameIdFormat,
    emailAttribute: row.emailAttribute,
    displayNameAttribute: row.displayNameAttribute,
    usernameAttribute: row.usernameAttribute,
    groupsAttribute: row.groupsAttribute,
    syncGroups: row.syncGroups,
    defaultGroups: row.defaultGroups,
    allowedDomains: row.allowedDomains,
    autoProvision: row.autoProvision,
    linkByEmail: row.linkByEmail,
    enforceSso: row.enforceSso,
    enabled: row.enabled,
    createdAt: row.createdAt,
    sp: { entityId: ep.entityId, acsUrl: ep.acsUrl, metadataUrl: ep.metadataUrl, loginUrl: ep.loginUrl },
  };
}

function encrypt(secret: string): { value: string } | { error: Response } {
  try {
    return { value: encryptSecret(secret) };
  } catch (err) {
    if (err instanceof SecretsConfigError) {
      return { error: new Response(JSON.stringify({ errorMessages: ['SECRETS_ENCRYPTION_KEY is not configured on the server; refusing to store the signing key'] }), { status: 409, headers: { 'Content-Type': 'application/json' } }) };
    }
    throw err;
  }
}

const origin = (c: any) => new URL(c.req.url).origin;

app.get(admin, async (c) => {
  const rows = await db.select().from(schema.samlProviders).orderBy(asc(schema.samlProviders.id));
  return c.json(rows.map((r) => present(r, origin(c))));
});

app.post(admin, requireFeature('sso_saml'), zValidator('json', createSchema), async (c) => {
  const body = c.req.valid('json');
  if (body.signRequests && !(body.spSigningKey && body.spSigningCertificate)) {
    return c.json({ errorMessages: ['Signing AuthnRequests needs both a signing key and its certificate'] }, 400);
  }
  const [dupe] = await db.select({ id: schema.samlProviders.id }).from(schema.samlProviders).where(eq(schema.samlProviders.slug, body.slug)).limit(1);
  if (dupe) return c.json({ errorMessages: ['A provider with this slug already exists'] }, 409);
  const { spSigningKey, ...rest } = body;
  let keyEnc: string | null = null;
  if (spSigningKey) {
    const enc = encrypt(spSigningKey);
    if ('error' in enc) return enc.error;
    keyEnc = enc.value;
  }
  const [row] = await db.insert(schema.samlProviders).values({ ...rest, spSigningCertificate: rest.spSigningCertificate ?? null, spSigningKeyEncrypted: keyEnc }).returning();
  return c.json(present(row, origin(c)), 201);
});

app.get(`${admin}/:id{[0-9]+}`, async (c) => {
  const [row] = await db.select().from(schema.samlProviders).where(eq(schema.samlProviders.id, Number(c.req.param('id')))).limit(1);
  if (!row) return c.json({ errorMessages: ['Not found'] }, 404);
  return c.json(present(row, origin(c)));
});

app.put(`${admin}/:id{[0-9]+}`, zValidator('json', updateSchema), async (c) => {
  const id = Number(c.req.param('id'));
  const { spSigningKey, ...rest } = c.req.valid('json');
  // Without a licence an existing provider can still be switched off, but not changed or switched on.
  const onlyDisabling = spSigningKey === undefined && Object.keys(rest).length === 1 && rest.enabled === false;
  if (!hasFeature('sso_saml') && !onlyDisabling) return c.json(featureRefusal('sso_saml'), 402);
  const [current] = await db.select().from(schema.samlProviders).where(eq(schema.samlProviders.id, id)).limit(1);
  if (!current) return c.json({ errorMessages: ['Not found'] }, 404);
  const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (spSigningKey !== undefined) {
    const enc = encrypt(spSigningKey);
    if ('error' in enc) return enc.error;
    patch.spSigningKeyEncrypted = enc.value;
  }
  const willSign = rest.signRequests ?? current.signRequests;
  const hasKey = spSigningKey !== undefined || !!current.spSigningKeyEncrypted;
  const hasCert = (rest.spSigningCertificate ?? current.spSigningCertificate) != null;
  if (willSign && !(hasKey && hasCert)) return c.json({ errorMessages: ['Signing AuthnRequests needs both a signing key and its certificate'] }, 400);
  if (Object.keys(rest).length === 0 && spSigningKey === undefined) return c.json({ errorMessages: ['Nothing to update'] }, 400);
  const [row] = await db.update(schema.samlProviders).set(patch).where(eq(schema.samlProviders.id, id)).returning();
  return c.json(present(row, origin(c)));
});

app.delete(`${admin}/:id{[0-9]+}`, async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(schema.samlProviders).where(eq(schema.samlProviders.id, id)).returning({ id: schema.samlProviders.id });
  if (!row) return c.json({ errorMessages: ['Not found'] }, 404);
  return c.body(null, 204);
});

/** Checks the stored configuration (certificates parse, a request can be built) and shows the SP values for the IdP. */
app.post(`${admin}/:id{[0-9]+}/test`, requireFeature('sso_saml'), async (c) => {
  const [row] = await db.select().from(schema.samlProviders).where(eq(schema.samlProviders.id, Number(c.req.param('id')))).limit(1);
  if (!row) return c.json({ errorMessages: ['Not found'] }, 404);
  const certs = splitPemCertificates(row.idpCertificates).map(describeCertificate);
  const problems: string[] = [];
  if (certs.length === 0 || certs.some((x) => !x)) problems.push('An IdP certificate could not be parsed');
  if (certs.length > 0 && certs.every((x) => x?.expired)) problems.push('Every IdP certificate has expired');
  try {
    await buildAuthnRequestUrl(spConfigFor(row, origin(c)), { requestId: '_test', relayState: 'test' });
  } catch (err) {
    problems.push(`Cannot build an AuthnRequest: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  return c.json({ ok: problems.length === 0, problems, certificates: certs, sp: present(row, origin(c)).sp });
});

export default app;
