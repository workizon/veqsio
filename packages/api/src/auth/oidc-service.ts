/**
 * Generic OIDC login flow: state/nonce/PKCE bookkeeping, user linking and provisioning, group sync.
 * The protocol work (discovery, JWKS, ID token validation) is in oidc-client.ts.
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
import { emailDomain, mapClaims, oidcClient, OidcError, pkcePair, randomToken, safeRedirectPath, type OidcClient } from './oidc-client';

const redis = getRedisClient();
const STATE_PREFIX = 'veqsio:oidc:state:';
const STATE_TTL = 600;

export type OidcProviderRow = typeof schema.oidcProviders.$inferSelect;

/** Errors surfaced to the browser are a fixed set of codes; details only go to the server log. */
export class OidcLoginError extends Error {
  constructor(public code: string, detail?: string) {
    super(detail ?? code);
    this.name = 'OidcLoginError';
  }
}

export function identityProviderKey(slug: string): string {
  return `oidc:${slug}`;
}

export async function getEnabledProviderBySlug(slug: string): Promise<OidcProviderRow | null> {
  const [row] = await db.select().from(schema.oidcProviders).where(and(eq(schema.oidcProviders.slug, slug), eq(schema.oidcProviders.enabled, true))).limit(1);
  return row ?? null;
}

/** Base URL the IdP redirects back to. Never derived from request headers in production. */
export function redirectUriFor(slug: string, requestOrigin: string): string {
  const configured = process.env.OIDC_REDIRECT_BASE_URL || process.env.PUBLIC_URL || process.env.WEB_URL;
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new OidcLoginError('misconfigured', 'OIDC_REDIRECT_BASE_URL (or WEB_URL) must be set in production');
  }
  const base = (configured || requestOrigin).replace(/\/+$/, '');
  return `${base}/rest/auth/1/oidc/${slug}/callback`;
}

interface StoredState {
  slug: string;
  verifier: string;
  nonce: string;
  bind: string; // sha256 of the browser-binding cookie
  next: string;
}

export const OIDC_BIND_COOKIE = 'oidc_bind';

export function hashBind(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

export async function startLogin(
  provider: OidcProviderRow,
  opts: { requestOrigin: string; next?: string | null; client?: OidcClient },
): Promise<{ url: string; bindToken: string }> {
  const client = opts.client ?? oidcClient;
  const doc = await client.discover(provider.issuer);
  const { verifier, challenge } = pkcePair();
  const state = randomToken(32);
  const nonce = randomToken(32);
  const bindToken = randomBytes(24).toString('base64url');
  const stored: StoredState = { slug: provider.slug, verifier, nonce, bind: hashBind(bindToken), next: safeRedirectPath(opts.next) };
  await redis.setex(`${STATE_PREFIX}${state}`, STATE_TTL, JSON.stringify(stored));
  const url = await client.buildAuthorizationUrl(doc, {
    clientId: provider.clientId,
    redirectUri: redirectUriFor(provider.slug, opts.requestOrigin),
    scopes: provider.scopes,
    state,
    nonce,
    challenge,
  });
  return { url, bindToken };
}

async function consumeState(state: string): Promise<StoredState | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) return null;
  const raw = await redis.get(`${STATE_PREFIX}${state}`);
  if (!raw) return null;
  await redis.del(`${STATE_PREFIX}${state}`); // single use
  try {
    return JSON.parse(raw) as StoredState;
  } catch {
    return null;
  }
}

export interface CallbackResult {
  sessionId: string;
  next: string;
  userId: number;
}

export async function finishLogin(
  provider: OidcProviderRow,
  p: { code: string; state: string; bindToken: string | undefined; requestOrigin: string; client?: OidcClient },
): Promise<CallbackResult> {
  const client = p.client ?? oidcClient;
  const stored = await consumeState(p.state);
  if (!stored || stored.slug !== provider.slug) throw new OidcLoginError('invalid_state', 'unknown, expired or mismatched state');
  // Login-CSRF: the browser that finishes the flow must be the one that started it.
  if (!p.bindToken || hashBind(p.bindToken) !== stored.bind) throw new OidcLoginError('invalid_state', 'browser binding mismatch');

  let claims;
  try {
    const doc = await client.discover(provider.issuer);
    const clientSecret = decryptSecret(provider.clientSecretEncrypted);
    const { idToken } = await client.exchangeCode(doc, {
      clientId: provider.clientId,
      clientSecret,
      code: p.code,
      redirectUri: redirectUriFor(provider.slug, p.requestOrigin),
      verifier: stored.verifier,
    });
    claims = await client.verifyIdToken(idToken, doc, { issuer: doc.issuer, clientId: provider.clientId, nonce: stored.nonce });
  } catch (err) {
    if (err instanceof OidcError) throw new OidcLoginError('token_invalid', err.code);
    throw new OidcLoginError('sso_failed', err instanceof Error ? err.name : 'unknown');
  }

  const mapped = mapClaims(claims, { emailClaim: provider.emailClaim, nameClaim: provider.nameClaim, groupsClaim: provider.groupsClaim });
  const user = await resolveUser(provider, mapped);
  if (mapped.groups.length > 0 || provider.groupsClaim) await syncGroups(user.id, provider, mapped.groups);
  const sessionId = await createSession(user.id);
  return { sessionId, next: stored.next, userId: user.id };
}

/* ------------------------------------------------------------------ */
/*  Linking and provisioning                                           */
/* ------------------------------------------------------------------ */

async function resolveUser(provider: OidcProviderRow, m: ReturnType<typeof mapClaims>) {
  const providerKey = identityProviderKey(provider.slug);
  const domains = ((provider.allowedDomains as string[]) || []).map((d) => d.toLowerCase());

  // 1. Already linked by (provider, subject): the IdP-asserted subject is the stable key.
  const [identity] = await db.select().from(schema.userIdentities)
    .where(and(eq(schema.userIdentities.provider, providerKey), eq(schema.userIdentities.providerUserId, m.subject))).limit(1);

  const checkDomain = () => {
    if (domains.length === 0) return;
    if (!m.email || !domains.includes(emailDomain(m.email))) throw new OidcLoginError('domain_not_allowed', 'email domain not allowed');
  };

  if (identity) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, identity.userId)).limit(1);
    if (!user) throw new OidcLoginError('sso_failed', 'identity without user');
    if (user.active === false) throw new OidcLoginError('account_disabled', 'user is deactivated');
    checkDomain();
    return user;
  }

  // 2. New identity: needs a usable email.
  if (!m.email || !/^[^@\s]+@[^@\s]+$/.test(m.email)) throw new OidcLoginError('email_missing', 'no usable email claim');
  if (m.emailVerified === false) throw new OidcLoginError('email_unverified', 'IdP reports the email as unverified');
  checkDomain();

  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, m.email)).limit(1);
  if (existing) {
    // Never merge accounts on an email the IdP has not explicitly verified, and only if the admin opted in.
    if (!provider.linkByEmail) throw new OidcLoginError('account_exists', 'email belongs to an existing user and linking is disabled');
    if (m.emailVerified !== true) throw new OidcLoginError('email_unverified', 'linking requires email_verified=true');
    if (existing.active === false) throw new OidcLoginError('account_disabled', 'user is deactivated');
    await db.insert(schema.userIdentities).values({
      userId: existing.id, provider: providerKey, providerUserId: m.subject, email: m.email, rawProfile: { syncedGroups: [] },
    });
    return existing;
  }

  if (!provider.autoProvision) throw new OidcLoginError('not_provisioned', 'auto-provisioning is disabled');

  // Auto-provisioning is new use of the paid SSO feature, and creates a seat.
  if (!hasFeature('sso_oidc_generic')) throw new OidcLoginError('licence_required', 'auto-provisioning needs a licence that includes generic OIDC');
  try { await assertSeatAvailable(); } catch (e) {
    if (e instanceof SeatLimitError) throw new OidcLoginError('seat_limit', 'the seat limit of the licence is reached');
    throw e;
  }

  const username = await uniqueUsername(m.username || m.email.split('@')[0]);
  const [user] = await db.insert(schema.users).values({
    username, email: m.email, displayName: m.name || m.email, passwordHash: null, active: true,
  }).returning();
  await db.insert(schema.userIdentities).values({
    userId: user.id, provider: providerKey, providerUserId: m.subject, email: m.email, rawProfile: { syncedGroups: [] },
  });
  return user;
}

async function uniqueUsername(seed: string): Promise<string> {
  const base = seed.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40) || 'user';
  let candidate = base;
  for (let i = 0; i < 20; i++) {
    if (candidate === 'admin') { candidate = `${base}${i + 2}`; continue; } // reserved: the built-in administrator passes every check by this name
    const [row] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, candidate)).limit(1);
    if (!row) return candidate;
    candidate = `${base}${i + 2}`;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}

/* ------------------------------------------------------------------ */
/*  Group sync                                                         */
/* ------------------------------------------------------------------ */

/**
 * Mirrors the IdP groups claim into Veqsio groups (created when missing). The list of groups this provider
 * has synced for a user is remembered in the identity's rawProfile.syncedGroups (no schema change), so a
 * membership is only ever removed when this provider added it earlier and the IdP no longer lists it.
 * Limitation: if an admin manually adds a user to a group that the IdP also manages and the IdP later
 * drops it, the membership is removed.
 */
export async function syncGroups(userId: number, provider: OidcProviderRow, groupNames: string[]): Promise<void> {
  if (!provider.groupsClaim) return;
  const providerKey = identityProviderKey(provider.slug);
  const [identity] = await db.select().from(schema.userIdentities)
    .where(and(eq(schema.userIdentities.userId, userId), eq(schema.userIdentities.provider, providerKey))).limit(1);
  if (!identity) return;
  const previous: string[] = Array.isArray((identity.rawProfile as any)?.syncedGroups) ? (identity.rawProfile as any).syncedGroups : [];

  for (const name of groupNames) {
    let [group] = await db.select().from(schema.groups).where(eq(schema.groups.name, name)).limit(1);
    if (!group) {
      [group] = await db.insert(schema.groups).values({ name, description: `Synced from ${provider.name}` }).onConflictDoNothing().returning();
      if (!group) [group] = await db.select().from(schema.groups).where(eq(schema.groups.name, name)).limit(1);
    }
    if (!group) continue;
    await db.insert(schema.userGroups).values({ userId, groupId: group.id }).onConflictDoNothing();
  }

  const current = new Set(groupNames);
  for (const name of previous.filter((n) => !current.has(n))) {
    const [group] = await db.select().from(schema.groups).where(eq(schema.groups.name, name)).limit(1);
    if (group) {
      await db.delete(schema.userGroups).where(and(eq(schema.userGroups.userId, userId), eq(schema.userGroups.groupId, group.id)));
    }
  }
  await db.update(schema.userIdentities)
    .set({ rawProfile: { ...(identity.rawProfile as object), syncedGroups: groupNames }, updatedAt: new Date() })
    .where(eq(schema.userIdentities.id, identity.id));
}

/* ------------------------------------------------------------------ */
/*  Enforce SSO                                                        */
/* ------------------------------------------------------------------ */

/**
 * When any enabled provider has enforce_sso set, password login is refused for everyone except system
 * administrators (break-glass, so a broken IdP cannot lock the instance out).
 */
export async function passwordLoginBlockedFor(userId: number): Promise<boolean> {
  const enforcing = await db.select({ id: schema.oidcProviders.id }).from(schema.oidcProviders)
    .where(and(eq(schema.oidcProviders.enabled, true), eq(schema.oidcProviders.enforceSso, true))).limit(1);
  if (enforcing.length === 0) return false;
  const { hasGlobalPermission } = await import('../rbac/service');
  return !(await hasGlobalPermission(userId, 'SYSTEM_ADMIN'));
}
