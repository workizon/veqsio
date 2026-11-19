/**
 * Minimal, strict OpenID Connect relying-party client (authorization code + PKCE).
 *
 * No database or session code lives here: everything is injectable (fetch, clock) so it can be tested
 * against a fake IdP. Only RS256 and ES256 ID tokens are accepted; `none`, HS* and everything else is refused.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'crypto';
import { outboundFetch } from '../security/outbound';

export class OidcError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export type IdTokenClaims = Record<string, unknown> & {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  nonce?: string;
};

export interface OidcClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number; // ms
  /** Allow http:// endpoints (local development only). */
  allowInsecureHttp?: boolean;
  cacheTtlMs?: number;
}

const ALLOWED_ALGS = ['RS256', 'ES256'] as const;
const CLOCK_SKEW_S = 60;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000;

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class OidcClient {
  private fetchImpl: typeof fetch;
  private now: () => number;
  private allowHttp: boolean;
  private ttl: number;
  private discoveryCache = new Map<string, { at: number; doc: DiscoveryDocument }>();
  private jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

  constructor(opts: OidcClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? (((input: any, init?: any) => outboundFetch(String(input), init)) as typeof fetch);
    this.now = opts.now ?? Date.now;
    this.allowHttp = opts.allowInsecureHttp ?? (process.env.NODE_ENV !== 'production' && process.env.OIDC_ALLOW_HTTP === 'true');
    this.ttl = opts.cacheTtlMs ?? 10 * 60_000;
  }

  /** Test hook. */
  setFetch(f: typeof fetch) {
    this.fetchImpl = f;
    this.clearCaches();
  }

  clearCaches() {
    this.discoveryCache.clear();
    this.jwksCache.clear();
  }

  private checkUrl(raw: string, what: string): URL {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new OidcError('invalid_url', `${what} is not a valid URL`);
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && this.allowHttp)) {
      throw new OidcError('insecure_url', `${what} must use https`);
    }
    if (u.username || u.password) throw new OidcError('invalid_url', `${what} must not contain credentials`);
    return u;
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      throw new OidcError('network', 'Could not reach the identity provider');
    }
    if (!res.ok) throw new OidcError('http_error', `Identity provider answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new OidcError('too_large', 'Identity provider response too large');
    try {
      return JSON.parse(text);
    } catch {
      throw new OidcError('bad_json', 'Identity provider returned invalid JSON');
    }
  }

  async discover(issuer: string): Promise<DiscoveryDocument> {
    const cached = this.discoveryCache.get(issuer);
    if (cached && this.now() - cached.at < this.ttl) return cached.doc;
    this.checkUrl(issuer, 'Issuer');
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const doc = (await this.fetchJson(url)) as Partial<DiscoveryDocument>;
    // The document must describe the issuer we asked about (mix-up / confused deputy protection).
    if (doc.issuer !== issuer && doc.issuer !== issuer.replace(/\/+$/, '')) {
      throw new OidcError('issuer_mismatch', 'Discovery document issuer does not match the configured issuer');
    }
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof doc[k] !== 'string') throw new OidcError('bad_discovery', `Discovery document lacks ${k}`);
      this.checkUrl(doc[k] as string, k);
    }
    const out = doc as DiscoveryDocument;
    this.discoveryCache.set(issuer, { at: this.now(), doc: out });
    return out;
  }

  private async getKeys(jwksUri: string, force = false): Promise<Jwk[]> {
    const cached = this.jwksCache.get(jwksUri);
    if (cached && !force && this.now() - cached.at < this.ttl) return cached.keys;
    // Do not let unknown key ids turn into a refetch storm.
    if (cached && force && this.now() - cached.at < 30_000) return cached.keys;
    const body = (await this.fetchJson(jwksUri)) as { keys?: Jwk[] };
    if (!body || !Array.isArray(body.keys)) throw new OidcError('bad_jwks', 'JWKS document is malformed');
    this.jwksCache.set(jwksUri, { at: this.now(), keys: body.keys });
    return body.keys;
  }

  async buildAuthorizationUrl(
    doc: DiscoveryDocument,
    p: { clientId: string; redirectUri: string; scopes: string; state: string; nonce: string; challenge: string },
  ): Promise<string> {
    const u = new URL(doc.authorization_endpoint);
    u.searchParams.set('client_id', p.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('scope', p.scopes);
    u.searchParams.set('state', p.state);
    u.searchParams.set('nonce', p.nonce);
    u.searchParams.set('code_challenge', p.challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  async exchangeCode(
    doc: DiscoveryDocument,
    p: { clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string },
  ): Promise<{ idToken: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code_verifier: p.verifier,
    });
    const data = (await this.fetchJson(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    })) as { id_token?: unknown };
    if (typeof data?.id_token !== 'string' || !data.id_token) throw new OidcError('no_id_token', 'Token response has no id_token');
    return { idToken: data.id_token };
  }

  async verifyIdToken(
    token: string,
    doc: DiscoveryDocument,
    expect: { issuer: string; clientId: string; nonce: string },
  ): Promise<IdTokenClaims> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new OidcError('bad_token', 'Malformed ID token');
    let header: { alg?: unknown; kid?: unknown };
    let payload: IdTokenClaims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new OidcError('bad_token', 'Malformed ID token');
    }
    if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') throw new OidcError('bad_token', 'Malformed ID token');
    const alg = header.alg;
    if (typeof alg !== 'string' || !(ALLOWED_ALGS as readonly string[]).includes(alg)) {
      throw new OidcError('bad_alg', 'ID token algorithm is not allowed');
    }
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    const signature = Buffer.from(parts[2], 'base64url');
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);

    const pickKey = (keys: Jwk[]): Jwk | undefined => {
      const kty = alg === 'RS256' ? 'RSA' : 'EC';
      const cands = keys.filter((k) => k.kty === kty && (k.use == null || k.use === 'sig') && (k.alg == null || k.alg === alg));
      if (kid) return cands.find((k) => k.kid === kid);
      return cands.length === 1 ? cands[0] : undefined;
    };
    let jwk = pickKey(await this.getKeys(doc.jwks_uri));
    if (!jwk) jwk = pickKey(await this.getKeys(doc.jwks_uri, true)); // key rotation
    if (!jwk) throw new OidcError('no_key', 'No matching signing key');

    let key: KeyObject;
    try {
      key = createPublicKey({ key: jwk as any, format: 'jwk' });
    } catch {
      throw new OidcError('bad_key', 'Signing key is invalid');
    }
    if (alg === 'ES256' && (jwk.crv !== 'P-256')) throw new OidcError('bad_key', 'Signing key curve is not allowed');
    let ok = false;
    try {
      ok = alg === 'RS256'
        ? cryptoVerify('sha256', signingInput, key, signature)
        : cryptoVerify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
    } catch {
      ok = false;
    }
    if (!ok) throw new OidcError('bad_signature', 'ID token signature is invalid');

    if (typeof payload.iss !== 'string' || payload.iss !== expect.issuer) throw new OidcError('bad_issuer', 'ID token issuer mismatch');
    const aud = payload.aud;
    const auds = Array.isArray(aud) ? aud : [aud];
    if (!auds.includes(expect.clientId)) throw new OidcError('bad_audience', 'ID token audience mismatch');
    if (auds.length > 1 && payload.azp !== expect.clientId) throw new OidcError('bad_audience', 'ID token authorized party mismatch');
    if (payload.azp !== undefined && payload.azp !== expect.clientId) throw new OidcError('bad_audience', 'ID token authorized party mismatch');
    const nowS = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < nowS) throw new OidcError('expired', 'ID token expired');
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > nowS) throw new OidcError('not_yet_valid', 'ID token not yet valid');
    if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > nowS) throw new OidcError('not_yet_valid', 'ID token issued in the future');
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new OidcError('bad_subject', 'ID token subject is invalid');
    if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, expect.nonce)) throw new OidcError('bad_nonce', 'ID token nonce mismatch');
    return payload;
  }
}

export const oidcClient = new OidcClient();

/* ------------------------------------------------------------------ */
/*  Claim mapping                                                      */
/* ------------------------------------------------------------------ */

export interface MappedClaims {
  subject: string;
  email: string | null;
  emailVerified: boolean | null; // null = IdP did not say
  name: string | null;
  username: string | null;
  groups: string[];
}

export function mapClaims(
  claims: IdTokenClaims,
  map: { emailClaim: string; nameClaim: string; groupsClaim: string | null },
): MappedClaims {
  const str = (v: unknown, max = 255) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const email = str(claims[map.emailClaim], 255);
  const ev = (claims as any).email_verified;
  let groups: string[] = [];
  if (map.groupsClaim) {
    const g = claims[map.groupsClaim];
    const arr = Array.isArray(g) ? g : typeof g === 'string' ? [g] : [];
    groups = [...new Set(arr.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x && x.length <= 255))].slice(0, 200);
  }
  return {
    subject: claims.sub,
    email: email ? email.toLowerCase() : null,
    emailVerified: typeof ev === 'boolean' ? ev : null,
    name: str(claims[map.nameClaim]),
    username: str(claims.preferred_username),
    groups,
  };
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** Only same-origin absolute paths. Everything else falls back to `fallback`. */
export function safeRedirectPath(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next || typeof next !== 'string' || next.length > 500) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const u = new URL(next, 'http://placeholder.invalid');
    if (u.origin !== 'http://placeholder.invalid') return fallback;
  } catch {
    return fallback;
  }
  return next;
}
