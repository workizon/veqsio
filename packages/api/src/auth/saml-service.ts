/**
 * SAML 2.0 SP-initiated login: state bookkeeping, user linking and JIT provisioning, group sync.
 * The protocol work (signature, audience, timestamps, replay) is in saml-validator.ts.
 */
import { hasFeature } from '../license';
import { assertSeatAvailable, SeatLimitError } from '../license/seats';
import { createHash, randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { getRedisClient } from '../services/redis-client';
import { createSession } from './session';
import { decryptSecret } from './secrets';
import { emailDomain, safeRedirectPath } from './oidc-client';
import { buildAuthnRequestUrl, newRequestId, validateSamlResponse, type SamlSpConfig, type ValidatedAssertion } from './saml-validator';
import { SamlError, splitPemCertificates, type MappedSamlProfile } from './saml-xml';
import { addToExistingGroups, syncIdentityGroups, uniqueUsername } from './sso-provisioning';

const redis = getRedisClient();
const STATE_PREFIX = 'veqsio:saml:state:';
const STATE_TTL = 600;

export type SamlProviderRow = typeof schema.samlProviders.$inferSelect;
export const SAML_BIND_COOKIE = 'saml_bind';

/** Errors surfaced to the browser are a fixed set of codes; details only go to the server log. */
export class SamlLoginError extends Error {
  constructor(public code: string, detail?: string) {
    super(detail ?? code);
    this.name = 'SamlLoginError';
  }
}

export const NAMEID_FORMATS = [
  'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:X509SubjectName',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
] as const;

export function identityProviderKey(slug: string): string {
  return `saml:${slug}`;
}

export async function getEnabledSamlProviderBySlug(slug: string): Promise<SamlProviderRow | null> {
  const [row] = await db.select().from(schema.samlProviders).where(and(eq(schema.samlProviders.slug, slug), eq(schema.samlProviders.enabled, true))).limit(1);
  return row ?? null;
}

/** Public base URL (scheme + host) of the web app. Never derived from request headers in production. */
export function samlBaseUrl(requestOrigin: string): string {
  const configured = process.env.SAML_BASE_URL || process.env.OIDC_REDIRECT_BASE_URL || process.env.PUBLIC_URL || process.env.WEB_URL;
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new SamlLoginError('misconfigured', 'SAML_BASE_URL (or WEB_URL) must be set in production');
  }
  return (configured || requestOrigin).replace(/\/+$/, '');
}

export function samlEndpoints(slug: string, requestOrigin: string) {
  const base = samlBaseUrl(requestOrigin);
  const root = `${base}/rest/auth/1/saml/${slug}`;
  return { entityId: `${root}/metadata`, acsUrl: `${root}/acs`, metadataUrl: `${root}/metadata`, loginUrl: `${root}/login` };
}

export function spConfigFor(provider: SamlProviderRow, requestOrigin: string): SamlSpConfig {
  const ep = samlEndpoints(provider.slug, requestOrigin);
  let signing: SamlSpConfig['signing'] = null;
  if (provider.signRequests && provider.spSigningKeyEncrypted) {
    signing = { privateKey: decryptSecret(provider.spSigningKeyEncrypted), certificate: provider.spSigningCertificate };
  }
  return {
    spEntityId: ep.entityId,
    acsUrl: ep.acsUrl,
    idpEntityId: provider.idpEntityId,
    idpSsoUrl: provider.idpSsoUrl,
    idpCertificates: provider.idpCertificates,
    nameIdFormat: provider.nameIdFormat,
    signing,
  };
}

interface StoredState {
  slug: string;
  requestId: string;
  bind: string; // sha256 of the browser-binding cookie
  next: string;
}

export function hashBind(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

export async function startLogin(provider: SamlProviderRow, opts: { requestOrigin: string; next?: string | null }): Promise<{ url: string; bindToken: string }> {
  const cfg = spConfigFor(provider, opts.requestOrigin);
  const relayState = randomBytes(32).toString('base64url'); // opaque; the real state lives server-side
  const requestId = newRequestId(randomBytes(16).toString('hex'));
  const bindToken = randomBytes(24).toString('base64url');
  const stored: StoredState = { slug: provider.slug, requestId, bind: hashBind(bindToken), next: safeRedirectPath(opts.next) };
  await redis.setex(`${STATE_PREFIX}${relayState}`, STATE_TTL, JSON.stringify(stored));
  const url = await buildAuthnRequestUrl(cfg, { requestId, relayState });
  return { url, bindToken };
}

async function consumeState(relayState: string): Promise<StoredState | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(relayState)) return null;
  const raw = await redis.get(`${STATE_PREFIX}${relayState}`);
  if (!raw) return null;
  await redis.del(`${STATE_PREFIX}${relayState}`); // single use, also when the response turns out to be invalid
  try {
    return JSON.parse(raw) as StoredState;
  } catch {
    return null;
  }
}

export interface SamlCallbackResult {
  sessionId: string;
  next: string;
  userId: number;
  username: string;
}

export async function finishLogin(
  provider: SamlProviderRow,
  p: {
    samlResponse: unknown;
    relayState: unknown;
    bindToken: string | undefined;
    requestOrigin: string;
    /** Test seam: replaces the response validation. Production code never passes it. */
    validate?: typeof validateSamlResponse;
  },
): Promise<SamlCallbackResult> {
  if (typeof p.relayState !== 'string') throw new SamlLoginError('invalid_state', 'missing RelayState');
  const stored = await consumeState(p.relayState);
  if (!stored || stored.slug !== provider.slug) throw new SamlLoginError('invalid_state', 'unknown, expired or mismatched state');
  // Login CSRF: the browser that finishes the flow must be the one that started it. The cookie is SameSite=None in
  // production (it has to ride the cross-site POST from the IdP) and Lax elsewhere, where it is checked when present.
  if (p.bindToken !== undefined || process.env.NODE_ENV === 'production') {
    if (!p.bindToken || hashBind(p.bindToken) !== stored.bind) throw new SamlLoginError('invalid_state', 'browser binding mismatch');
  }

  let validated: ValidatedAssertion;
  try {
    const cfg = spConfigFor(provider, p.requestOrigin);
    validated = await (p.validate ?? validateSamlResponse)({
      samlResponse: p.samlResponse,
      cfg,
      expectedRequestId: stored.requestId,
      mapping: {
        emailAttribute: provider.emailAttribute,
        displayNameAttribute: provider.displayNameAttribute,
        usernameAttribute: provider.usernameAttribute,
        groupsAttribute: provider.groupsAttribute,
        syncGroups: provider.syncGroups,
        nameIdFormat: provider.nameIdFormat,
      },
    });
  } catch (err) {
    if (err instanceof SamlError) throw new SamlLoginError(`saml_${err.code}`, err.message);
    throw new SamlLoginError('sso_failed', err instanceof Error ? err.name : 'unknown');
  }
  if (validated.assertion.nameIdFormat?.endsWith(':transient')) throw new SamlLoginError('nameid_transient', 'transient NameIDs cannot identify a user');

  const user = await resolveUser(provider, validated.profile);
  if (provider.syncGroups) await syncIdentityGroups(user.id, identityProviderKey(provider.slug), provider.name, validated.profile.groups);
  const sessionId = await createSession(user.id);
  return { sessionId, next: stored.next, userId: user.id, username: user.username };
}

/* ------------------------------------------------------------------ */
/*  Linking and provisioning                                           */
/* ------------------------------------------------------------------ */

async function resolveUser(provider: SamlProviderRow, m: MappedSamlProfile) {
  const providerKey = identityProviderKey(provider.slug);
  const domains = ((provider.allowedDomains as string[]) || []).map((d) => d.toLowerCase());
  const checkDomain = () => {
    if (domains.length === 0) return;
    if (!m.email || !domains.includes(emailDomain(m.email))) throw new SamlLoginError('domain_not_allowed', 'email domain not allowed');
  };

  const [identity] = await db.select().from(schema.userIdentities)
    .where(and(eq(schema.userIdentities.provider, providerKey), eq(schema.userIdentities.providerUserId, m.subject))).limit(1);

  if (identity) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, identity.userId)).limit(1);
    if (!user) throw new SamlLoginError('sso_failed', 'identity without user');
    if (user.active === false) throw new SamlLoginError('account_disabled', 'user is deactivated');
    checkDomain();
    return user;
  }

  if (!m.email) throw new SamlLoginError('email_missing', 'no usable email attribute');
  checkDomain();

  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, m.email)).limit(1);
  if (existing) {
    if (!provider.linkByEmail) throw new SamlLoginError('account_exists', 'email belongs to an existing user and linking is disabled');
    if (existing.active === false) throw new SamlLoginError('account_disabled', 'user is deactivated');
    await db.insert(schema.userIdentities).values({
      userId: existing.id, provider: providerKey, providerUserId: m.subject, email: m.email, rawProfile: { syncedGroups: [] },
    });
    return existing;
  }

  if (!provider.autoProvision) throw new SamlLoginError('not_provisioned', 'JIT provisioning is disabled');
  if (!hasFeature('sso_saml')) throw new SamlLoginError('licence_required', 'JIT provisioning needs a licence that includes SAML');
  try { await assertSeatAvailable(); } catch (e) {
    if (e instanceof SeatLimitError) throw new SamlLoginError('seat_limit', 'the seat limit of the licence is reached');
    throw e;
  }

  const username = await uniqueUsername(m.username || m.email.split('@')[0]);
  const [user] = await db.insert(schema.users).values({
    username, email: m.email, displayName: m.name || m.email, passwordHash: null, active: true,
  }).returning();
  await db.insert(schema.userIdentities).values({
    userId: user.id, provider: providerKey, providerUserId: m.subject, email: m.email, rawProfile: { syncedGroups: [] },
  });
  await addToExistingGroups(user.id, ((provider.defaultGroups as string[]) || []).filter((g) => typeof g === 'string'));
  return user;
}

/* ------------------------------------------------------------------ */
/*  Enforce SSO                                                        */
/* ------------------------------------------------------------------ */

/**
 * A SAML provider with enforce_sso blocks password login for the users it covers: everybody when it has no domain
 * list, otherwise only users whose email domain is listed. System administrators are always exempt (break-glass).
 * Ignored while the licence does not include SAML (so a lapsed licence cannot lock people out).
 */
export async function samlPasswordLoginBlockedFor(userId: number): Promise<boolean> {
  if (!hasFeature('sso_saml')) return false;
  const enforcing = await db.select({ allowedDomains: schema.samlProviders.allowedDomains }).from(schema.samlProviders)
    .where(and(eq(schema.samlProviders.enabled, true), eq(schema.samlProviders.enforceSso, true)));
  if (enforcing.length === 0) return false;
  const [user] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const domain = user?.email ? emailDomain(user.email) : '';
  const covered = enforcing.some((p) => {
    const d = ((p.allowedDomains as string[]) || []).map((x) => x.toLowerCase());
    return d.length === 0 || d.includes(domain);
  });
  if (!covered) return false;
  const { hasGlobalPermission } = await import('../rbac/service');
  return !(await hasGlobalPermission(userId, 'SYSTEM_ADMIN'));
}

export { splitPemCertificates };
