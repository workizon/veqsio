/**
 * SAML Response validation on top of @node-saml/node-saml (which verifies the XML signature with xml-crypto, binds
 * InResponseTo, checks audience and timestamps and detects replayed assertions) plus the checks node-saml 5 only
 * logs a warning for or does not make at all:
 *   - the DOCTYPE/entity/size pre-check (saml-xml.ts) runs BEFORE any XML parser sees the document,
 *   - the assertion data is read ONLY from `profile.getAssertionXml()`, the element whose signature was verified,
 *     never from the posted document (XML signature wrapping),
 *   - Recipient of a bearer SubjectConfirmation and Destination of the Response must be our ACS URL,
 *   - the audience restriction must exist and name our entity ID, the issuer must be the configured IdP,
 *   - NotOnOrAfter must be present everywhere it is required, clock skew is capped at 2 minutes.
 * Nothing in here logs the response or the assertion.
 */
import { InMemoryCacheProvider, SAML, ValidateInResponseTo, type CacheItem, type CacheProvider } from '@node-saml/node-saml';
import { X509Certificate } from 'node:crypto';
import { getRedisClient } from '../services/redis-client';
import {
  SamlError, decodeSamlResponse, extractAssertion, mapSamlProfile, normalizeEndpoint, peekResponseRoot, splitPemCertificates,
  type ExtractedAssertion, type MappedSamlProfile, type SamlMappingConfig,
} from './saml-xml';

export const MAX_CLOCK_SKEW_MS = 120_000;
const MAX_ASSERTION_AGE_MS = 8 * 3600_000;

export interface SamlSpConfig {
  /** Our entity ID (the Audience the IdP must name). */
  spEntityId: string;
  /** Our assertion consumer service URL (Recipient / Destination). */
  acsUrl: string;
  idpEntityId: string;
  idpSsoUrl: string;
  /** One or more PEM certificates; a signature that verifies against any of them is accepted (key rollover). */
  idpCertificates: string;
  nameIdFormat: string;
  signing?: { privateKey: string; certificate?: string | null } | null;
}

/** Replay protection store for assertion IDs: Redis (SET NX PX) with the in-memory fallback of the shared client. */
export interface ReplayStore {
  /** Resolves true when the key was new, false when it was already present. */
  saveIfAbsent(key: string, expiresAtMs: number): Promise<boolean>;
}

const redis = getRedisClient();
const REPLAY_PREFIX = 'veqsio:saml:replay:';

export const redisReplayStore: ReplayStore = {
  async saveIfAbsent(key, expiresAtMs) {
    const ttl = Math.max(1000, Math.min(expiresAtMs - Date.now() + MAX_CLOCK_SKEW_MS, MAX_ASSERTION_AGE_MS + MAX_CLOCK_SKEW_MS));
    const res = await redis.set(`${REPLAY_PREFIX}${key}`, '1', 'PX', ttl, 'NX');
    return res === 'OK';
  },
};

/** Request-ID cache for one validation: holds exactly the request ID this browser session started, nothing else. */
class SingleRequestCache implements CacheProvider {
  private ids = new Map<string, string>();
  constructor(expectedId: string | null, private replay: ReplayStore, private scope: string) {
    if (expectedId) this.ids.set(expectedId, new Date().toISOString());
  }
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    if (this.ids.has(key)) return null;
    this.ids.set(key, value);
    return { value, createdAt: Date.now() };
  }
  async getAsync(key: string) { return this.ids.get(key) ?? null; }
  async removeAsync(key: string | null) { if (key == null) return null; const v = this.ids.get(key) ?? null; this.ids.delete(key); return v; }
  async consumeAsync(key: string) { return this.removeAsync(key); }
  async saveIfAbsentAsync(key: string, _value: string, expiresAtMs: number) { return this.replay.saveIfAbsent(`${this.scope}:${key}`, expiresAtMs); }
}

function baseOptions(cfg: SamlSpConfig) {
  const certs = splitPemCertificates(cfg.idpCertificates);
  if (certs.length === 0) throw new SamlError('misconfigured', 'no usable IdP certificate');
  return {
    entryPoint: cfg.idpSsoUrl,
    issuer: cfg.spEntityId,
    callbackUrl: cfg.acsUrl,
    audience: cfg.spEntityId,
    idpIssuer: cfg.idpEntityId,
    idpCert: certs,
    identifierFormat: cfg.nameIdFormat,
    acceptedClockSkewMs: MAX_CLOCK_SKEW_MS,
    maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,
    // Either the Response or the Assertion must be signed (both are fine). Unsigned is always refused.
    wantAssertionsSigned: false,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    rejectReplayedAssertions: true,
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256' as const,
    digestAlgorithm: 'sha256',
  };
}

/** Builds the HTTP-Redirect AuthnRequest URL. The request ID is chosen by us so it can be stored server-side. */
export async function buildAuthnRequestUrl(cfg: SamlSpConfig, p: { requestId: string; relayState: string }): Promise<string> {
  const saml = new SAML({
    ...baseOptions(cfg),
    generateUniqueId: () => p.requestId,
    cacheProvider: new InMemoryCacheProvider(),
    ...(cfg.signing ? { privateKey: cfg.signing.privateKey, signatureAlgorithm: 'sha256' as const } : {}),
  });
  return saml.getAuthorizeUrlAsync(p.relayState, undefined, {});
}

export function newRequestId(randomHex: string): string {
  return `_${randomHex}`; // xs:ID must not start with a digit
}

export interface ValidatedAssertion {
  assertion: ExtractedAssertion;
  profile: MappedSamlProfile;
}

/** Maps node-saml / our own failures to a short, stable code. The detail is for the server log only. */
export function classifyError(err: unknown): SamlError {
  if (err instanceof SamlError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  const m = msg.toLowerCase();
  if (name === 'ReplayedAssertionError' || m.includes('already been received')) return new SamlError('replayed', msg);
  if (m.includes('inresponseto')) return new SamlError('in_response_to', msg);
  if (m.includes('audience')) return new SamlError('audience', msg);
  if (m.includes('signature') || m.includes('multiple assertions') || m.includes('cannot obtain assertion') || m.includes('no signature')) return new SamlError('signature', msg);
  if (m.includes('notonorafter') || m.includes('expired') || m.includes('notbefore') || m.includes('not yet valid') || m.includes('timestamp') || m.includes('subject confirmation')) return new SamlError('assertion_expired', msg);
  if (m.includes('issuer')) return new SamlError('issuer', msg);
  if (name === 'SamlStatusError' || m.includes('provider returned')) return new SamlError('idp_error', msg);
  return new SamlError('invalid_response', msg);
}

/**
 * Validates a posted `SAMLResponse` for ONE pending login.
 * @param expectedRequestId the AuthnRequest ID stored when this browser session started the flow
 */
export async function validateSamlResponse(p: {
  samlResponse: unknown;
  cfg: SamlSpConfig;
  mapping: SamlMappingConfig;
  expectedRequestId: string;
  replay?: ReplayStore;
}): Promise<ValidatedAssertion> {
  const xml = decodeSamlResponse(p.samlResponse);
  const cfg = p.cfg;

  // Reject-only look at the unverified root: it must be a Response and, when it names a Destination, it must be us.
  const root = peekResponseRoot(xml);
  if (root.root !== 'Response') throw new SamlError('invalid_response', 'root element is not a Response');
  if (root.destination && normalizeEndpoint(root.destination) !== normalizeEndpoint(cfg.acsUrl)) throw new SamlError('destination', 'Destination does not match the ACS URL');

  let profile;
  try {
    const saml = new SAML({
      ...baseOptions(cfg),
      cacheProvider: new SingleRequestCache(p.expectedRequestId, p.replay ?? redisReplayStore, cfg.idpEntityId),
    });
    ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: Buffer.from(xml, 'utf8').toString('base64') }));
  } catch (err) {
    throw classifyError(err);
  }
  if (!profile || typeof profile.getAssertionXml !== 'function') throw new SamlError('invalid_response', 'no assertion');

  // From here on only the VERIFIED assertion element is read.
  const assertion = extractAssertion(profile.getAssertionXml());

  if (!assertion.issuer || assertion.issuer !== cfg.idpEntityId) throw new SamlError('issuer', 'assertion issuer does not match the configured IdP');
  if (!assertion.audiences.includes(cfg.spEntityId)) throw new SamlError('audience', 'assertion is not addressed to this service provider');
  if (!assertion.conditionsNotOnOrAfter) throw new SamlError('assertion_expired', 'assertion has no NotOnOrAfter');
  if (!assertion.hasAuthnStatement) throw new SamlError('invalid_response', 'assertion has no AuthnStatement');
  const acs = normalizeEndpoint(cfg.acsUrl);
  const bearer = assertion.bearer.filter((b) => b.recipient && normalizeEndpoint(b.recipient) === acs && b.inResponseTo === p.expectedRequestId);
  if (bearer.length === 0) throw new SamlError('recipient', 'no bearer SubjectConfirmation for this ACS URL and request');
  const now = Date.now();
  if (!bearer.some((b) => b.notOnOrAfter && Date.parse(b.notOnOrAfter) + MAX_CLOCK_SKEW_MS > now)) throw new SamlError('assertion_expired', 'SubjectConfirmation expired');

  return { assertion, profile: mapSamlProfile(assertion, p.mapping) };
}

/** Parses a pasted certificate and returns its subject, validity and fingerprint, or null when it is not an X.509 certificate. */
export function describeCertificate(pem: string): { subject: string; validFrom: string; validTo: string; fingerprint256: string; expired: boolean } | null {
  try {
    const c = new X509Certificate(pem);
    return { subject: c.subject.replace(/\n/g, ', '), validFrom: new Date(c.validFrom).toISOString(), validTo: new Date(c.validTo).toISOString(), fingerprint256: c.fingerprint256, expired: new Date(c.validTo).getTime() < Date.now() };
  } catch {
    return null;
  }
}
