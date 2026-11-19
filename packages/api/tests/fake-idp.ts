/**
 * A fake OpenID Connect provider for tests: discovery, JWKS and token endpoints served through an
 * injected fetch, with ID tokens signed by hand using node:crypto.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign, createHmac, type KeyObject } from 'crypto';

const b64 = (v: Buffer | string) => Buffer.from(v).toString('base64url');

export class FakeIdp {
  issuer: string;
  kid = 'test-key-1';
  rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  /** Called by the token endpoint to produce the id_token; tests set it after reading the authorize URL. */
  mintIdToken: (() => string) | null = null;
  lastTokenRequest: URLSearchParams | null = null;
  codeChallenge: string | null = null;
  requests: string[] = [];

  constructor(issuer = 'https://idp.test') {
    this.issuer = issuer;
  }

  jwks() {
    const rsaJwk = { ...this.rsa.publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', alg: 'RS256' };
    const ecJwk = { ...this.ec.publicKey.export({ format: 'jwk' }), kid: 'test-ec-1', use: 'sig', alg: 'ES256' };
    return { keys: [rsaJwk, ecJwk] };
  }

  /** Sign a JWT. `alg` may be forged ('none', 'HS256') to test rejection. */
  signJwt(claims: Record<string, unknown>, opts: { alg?: string; kid?: string; key?: KeyObject } = {}): string {
    const alg = opts.alg ?? 'RS256';
    const header = { alg, typ: 'JWT', ...(alg === 'ES256' ? { kid: opts.kid ?? 'test-ec-1' } : { kid: opts.kid ?? this.kid }) };
    const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
    if (alg === 'none') return `${input}.`;
    if (alg === 'RS256') return `${input}.${b64(cryptoSign('sha256', Buffer.from(input), opts.key ?? this.rsa.privateKey))}`;
    if (alg === 'ES256') return `${input}.${b64(cryptoSign('sha256', Buffer.from(input), { key: opts.key ?? this.ec.privateKey, dsaEncoding: 'ieee-p1363' }))}`;
    if (alg === 'HS256') {
      // Classic attack: HMAC keyed with the public key material.
      const secret = JSON.stringify(this.jwks().keys[0]);
      return `${input}.${b64(createHmac('sha256', secret).update(input).digest())}`;
    }
    throw new Error('unsupported test alg');
  }

  idToken(clientId: string, nonce: string, extra: Record<string, unknown> = {}, opts: { alg?: string; kid?: string; key?: KeyObject } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return this.signJwt({ iss: this.issuer, aud: clientId, sub: 'sub-123', iat: now, exp: now + 300, nonce, email: 'jane@example.com', email_verified: true, name: 'Jane Doe', ...extra }, opts);
  }

  fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    this.requests.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === `${this.issuer}/.well-known/openid-configuration`) {
      return json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
      });
    }
    if (url === `${this.issuer}/jwks`) return json(this.jwks());
    if (url === `${this.issuer}/token` && init?.method === 'POST') {
      const params = new URLSearchParams(String(init.body));
      this.lastTokenRequest = params;
      if (this.codeChallenge) {
        const expected = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
        if (expected !== this.codeChallenge) return json({ error: 'invalid_grant' }, 400);
      }
      if (params.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400);
      if (!this.mintIdToken) return json({ error: 'server_error' }, 500);
      return json({ access_token: 'at', token_type: 'Bearer', id_token: this.mintIdToken() });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}
