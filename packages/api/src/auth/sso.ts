import { uniqueUsername } from './sso-provisioning';
import { assertSeatAvailable } from '../license/seats';
import { getRedisClient } from '../services/redis-client';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and } from 'drizzle-orm';
import { createSession } from './session';

const redis = getRedisClient();

const STATE_PREFIX = 'veqsio:sso:state:';
const STATE_TTL = 600; // 10 minutes

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SSOSettings {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
}

export interface OIDCConfig {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export interface JWKS {
  keys: Array<{
    kty: string;
    kid: string;
    use?: string;
    n: string;
    e: string;
    x5c?: string[];
  }>;
}

export interface IDTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  email?: string;
  name?: string;
  preferred_username?: string;
  groups?: string[];
  nonce?: string;
}

/* ------------------------------------------------------------------ */
/*  PKCE (Web Crypto API)                                              */
/* ------------------------------------------------------------------ */

function base64urlEncode(buffer: ArrayBuffer): string {
  return Buffer.from(buffer)
    .toString('base64url')
    .replace(/=+$/, '');
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(64));
  const verifier = base64urlEncode(verifierBytes.buffer);
  const challengeBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64urlEncode(challengeBuffer);
  return { verifier, challenge };
}

/* ------------------------------------------------------------------ */
/*  State Store (Redis)                                                */
/* ------------------------------------------------------------------ */

export async function storeState(state: string, verifier: string, nonce: string): Promise<void> {
  await redis.setex(`${STATE_PREFIX}${state}`, STATE_TTL, JSON.stringify({ verifier, nonce }));
}

export async function getState(state: string): Promise<{ verifier: string; nonce: string } | null> {
  const raw = await redis.get(`${STATE_PREFIX}${state}`);
  if (!raw) return null;
  await redis.del(`${STATE_PREFIX}${state}`);
  return JSON.parse(raw) as { verifier: string; nonce: string };
}

/* ------------------------------------------------------------------ */
/*  OIDC Discovery                                                     */
/* ------------------------------------------------------------------ */

export async function discoverOIDC(tenantId: string): Promise<OIDCConfig> {
  const url = `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<OIDCConfig>;
}

async function fetchJWKS(jwksUri: string): Promise<JWKS> {
  const res = await fetch(jwksUri);
  if (!res.ok) {
    throw new Error(`JWKS fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<JWKS>;
}

/* ------------------------------------------------------------------ */
/*  JWT Verification (Web Crypto API)                                  */
/* ------------------------------------------------------------------ */

function parseJWT(token: string): { header: { alg: string; kid?: string }; payload: unknown; signature: Uint8Array; signingInput: string } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8')) as { alg: string; kid?: string };
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  const signature = Buffer.from(parts[2], 'base64url');
  return { header, payload, signature: new Uint8Array(signature), signingInput: `${parts[0]}.${parts[1]}` };
}

async function importJWK(jwk: JWKS['keys'][number]): Promise<CryptoKey> {
  if (jwk.kty !== 'RSA') {
    throw new Error(`Unsupported key type: ${jwk.kty}`);
  }
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: false } as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

async function verifyJWT(token: string, jwks: JWKS, expectedIssuer: string, expectedAudience: string, expectedNonce?: string): Promise<IDTokenClaims> {
  const { header, payload, signature, signingInput } = parseJWT(token);

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}`);
  }

  const keyData = jwks.keys.find((k) => k.kid === header.kid && (k.use == null || k.use === 'sig'));
  if (!keyData) {
    throw new Error(`JWK not found for kid: ${header.kid}`);
  }

  const key = await importJWK(keyData);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    new Uint8Array(signature),
    new TextEncoder().encode(signingInput)
  );

  if (!valid) {
    throw new Error('JWT signature verification failed');
  }

  const claims = payload as IDTokenClaims;

  if (claims.iss !== expectedIssuer) {
    throw new Error(`Invalid issuer: expected ${expectedIssuer}, got ${claims.iss}`);
  }

  if (claims.aud !== expectedAudience) {
    throw new Error(`Invalid audience: expected ${expectedAudience}, got ${claims.aud}`);
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) {
    throw new Error('ID token expired');
  }

  if (expectedNonce && claims.nonce !== expectedNonce) {
    throw new Error('Invalid nonce');
  }

  return claims;
}

/* ------------------------------------------------------------------ */
/*  User Provisioning                                                  */
/* ------------------------------------------------------------------ */

export async function provisionUser(claims: IDTokenClaims): Promise<{ user: typeof schema.users.$inferSelect; isNew: boolean }> {
  const email = claims.email || claims.preferred_username || '';
  const displayName = claims.name || email;
  if (!email) {
    throw new Error('ID token missing email claim');
  }

  // Check for existing identity
  const identities = await db
    .select()
    .from(schema.userIdentities)
    .where(
      and(
        eq(schema.userIdentities.provider, 'microsoft'),
        eq(schema.userIdentities.providerUserId, claims.sub)
      )
    )
    .limit(1);

  if (identities.length > 0) {
    const userRows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, identities[0].userId))
      .limit(1);

    if (userRows.length > 0) {
      const user = userRows[0];
      // Update profile if changed
      if (user.displayName !== displayName || user.email !== email) {
        await db
          .update(schema.users)
          .set({ displayName, email, updatedAt: new Date() })
          .where(eq(schema.users.id, user.id));
        user.displayName = displayName;
        user.email = email;
      }
      return { user, isNew: false };
    }
  }

  // Check for existing user by email
  const existingUsers = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (existingUsers.length > 0) {
    const user = existingUsers[0];
    // Link identity
    await db.insert(schema.userIdentities).values({
      userId: user.id,
      provider: 'microsoft',
      providerUserId: claims.sub,
      email,
      rawProfile: claims as unknown as Record<string, unknown>,
    });
    return { user, isNew: false };
  }

  // Create new user (this takes a seat; throws SeatLimitError when the licence is full)
  await assertSeatAvailable();
  const username = await uniqueUsername(email.split('@')[0]);
  const [user] = await db
    .insert(schema.users)
    .values({
      username,
      email,
      displayName,
      passwordHash: null,
      active: true,
    })
    .returning();

  await db.insert(schema.userIdentities).values({
    userId: user.id,
    provider: 'microsoft',
    providerUserId: claims.sub,
    email,
    rawProfile: claims as unknown as Record<string, unknown>,
  });

  return { user, isNew: true };
}

/* ------------------------------------------------------------------ */
/*  Group Sync                                                         */
/* ------------------------------------------------------------------ */

export async function syncGroups(userId: number, groups: string[]): Promise<void> {
  if (!groups || groups.length === 0) return;

  for (const groupName of groups) {
    const existing = await db
      .select()
      .from(schema.groups)
      .where(eq(schema.groups.name, groupName))
      .limit(1);

    let groupId: number;
    if (existing.length === 0) {
      const [group] = await db
        .insert(schema.groups)
        .values({ name: groupName, description: `Synced from Microsoft Entra ID` })
        .returning();
      groupId = group.id;
    } else {
      groupId = existing[0].id;
    }

    const membership = await db
      .select()
      .from(schema.userGroups)
      .where(and(eq(schema.userGroups.userId, userId), eq(schema.userGroups.groupId, groupId)))
      .limit(1);

    if (membership.length === 0) {
      await db.insert(schema.userGroups).values({ userId, groupId });
    }
  }
}

/* ------------------------------------------------------------------ */
/*  SSO Flow                                                           */
/* ------------------------------------------------------------------ */

export async function initiateSSO(settings: SSOSettings): Promise<{ redirectUrl: string; state: string }> {
  const oidc = await discoverOIDC(settings.tenantId);
  const { verifier, challenge } = await generatePKCE();
  const state = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);

  await storeState(state, verifier, nonce);

  const params = new URLSearchParams({
    client_id: settings.clientId,
    response_type: 'code',
    redirect_uri: settings.redirectUri,
    response_mode: 'query',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const redirectUrl = `${oidc.authorization_endpoint}?${params.toString()}`;
  return { redirectUrl, state };
}

export async function handleSSOCallback(
  code: string,
  state: string,
  settings: SSOSettings
): Promise<{ sessionId: string; user: { id: number; username: string; displayName: string; email: string } }> {
  const stored = await getState(state);
  if (!stored) {
    throw new Error('Invalid or expired state parameter');
  }

  const oidc = await discoverOIDC(settings.tenantId);

  const tokenRes = await fetch(oidc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code,
      redirect_uri: settings.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: stored.verifier,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    console.error(`[sso] token exchange failed: ${tokenRes.status} ${String(text).slice(0, 300)}`);
    throw new Error('Token exchange failed');
  }

  const tokenData = (await tokenRes.json()) as { id_token: string; access_token?: string };
  if (!tokenData.id_token) {
    throw new Error('ID token missing from token response');
  }

  const jwks = await fetchJWKS(oidc.jwks_uri);
  const claims = await verifyJWT(
    tokenData.id_token,
    jwks,
    oidc.issuer,
    settings.clientId,
    stored.nonce
  );

  const { user } = await provisionUser(claims);

  if (claims.groups && Array.isArray(claims.groups)) {
    await syncGroups(user.id, claims.groups);
  }

  const sessionId = await createSession(user.id);

  return {
    sessionId,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Settings Helpers                                                   */
/* ------------------------------------------------------------------ */

export async function getActiveSSOSettings(): Promise<SSOSettings | null> {
  const rows = await db
    .select()
    .from(schema.ssoSettings)
    .where(eq(schema.ssoSettings.active, true))
    .limit(1);

  if (rows.length === 0) return null;
  const s = rows[0];
  return {
    clientId: s.clientId,
    clientSecret: s.clientSecret,
    tenantId: s.tenantId,
    redirectUri: s.redirectUri,
  };
}
