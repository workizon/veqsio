import { SignedXml } from 'xml-crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** A throw-away RSA key + self-signed certificate (openssl is available in the test environment). */
export async function makeKeyPair(cn = 'fake-idp'): Promise<{ privateKey: string; certificate: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'saml-'));
  try {
    const proc = Bun.spawn(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-subj', `/CN=${cn}`, '-days', '30'], { stdout: 'ignore', stderr: 'ignore' });
    if ((await proc.exited) !== 0) throw new Error('openssl failed');
    return { privateKey: readFileSync(join(dir, 'k.pem'), 'utf8'), certificate: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ResponseOptions {
  requestId: string | null;
  acsUrl: string;
  audience: string;
  issuer?: string;
  email?: string | null;
  name?: string;
  groups?: string[];
  nameId?: string;
  nameIdFormat?: string;
  extraAttributes?: Record<string, string[]>;
  /** milliseconds relative to now */
  notBefore?: number;
  notOnOrAfter?: number;
  recipient?: string;
  destination?: string | null;
  assertionId?: string;
  signAssertion?: boolean;
  signResponse?: boolean;
  key?: { privateKey: string; certificate: string };
  omitAudience?: boolean;
}

let counter = 0;

export class FakeSamlIdp {
  entityId = 'https://idp.test/entity';
  ssoUrl = 'https://idp.test/sso';
  constructor(public key: { privateKey: string; certificate: string }) {}

  /** What the IdP sees when the browser arrives with the redirect-binding AuthnRequest. */
  parseRequest(location: string) {
    const url = new URL(location);
    const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    const attr = (name: string) => xml.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
    return {
      url, xml, id: attr('ID')!, destination: attr('Destination'), acsUrl: attr('AssertionConsumerServiceURL'),
      issuer: xml.match(/<saml:Issuer[^>]*>([^<]*)</)?.[1] ?? null,
      relayState: url.searchParams.get('RelayState')!, signed: url.searchParams.has('Signature'), sigAlg: url.searchParams.get('SigAlg'),
    };
  }

  private sign(xml: string, ref: string, location: string, key: { privateKey: string }): string {
    const sig = new SignedXml({ privateKey: key.privateKey, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    sig.addReference({
      xpath: ref,
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    sig.computeSignature(xml, { location: { reference: location, action: 'after' } });
    return sig.getSignedXml();
  }

  assertionXml(o: ResponseOptions, id: string): string {
    const now = Date.now();
    const email = o.email === undefined ? 'jane@example.com' : o.email;
    const attrs: Record<string, string[]> = { ...(email ? { email: [email] } : {}), displayName: [o.name ?? 'Jane Doe'], ...(o.groups ? { groups: o.groups } : {}), ...(o.extraAttributes ?? {}) };
    const attrXml = Object.entries(attrs).map(([n, vs]) => `<saml:Attribute Name="${esc(n)}">${vs.map((v) => `<saml:AttributeValue xsi:type="xs:string">${esc(v)}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('');
    const irt = o.requestId ? ` InResponseTo="${o.requestId}"` : '';
    return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ID="${id}" Version="2.0" IssueInstant="${iso(now)}">`
      + `<saml:Issuer>${esc(o.issuer ?? this.entityId)}</saml:Issuer>`
      + `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'}">${esc(o.nameId ?? email ?? 'subject-1')}</saml:NameID>`
      + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${iso(now + (o.notOnOrAfter ?? 300_000))}" Recipient="${esc(o.recipient ?? o.acsUrl)}"/></saml:SubjectConfirmation></saml:Subject>`
      + `<saml:Conditions NotBefore="${iso(now + (o.notBefore ?? -5000))}" NotOnOrAfter="${iso(now + (o.notOnOrAfter ?? 300_000))}">${o.omitAudience ? '' : `<saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction>`}</saml:Conditions>`
      + `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s${++counter}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
      + `<saml:AttributeStatement>${attrXml}</saml:AttributeStatement></saml:Assertion>`;
  }

  /** The signed assertion element on its own (for wrapping attacks). */
  signedAssertion(o: ResponseOptions, id = `_a${++counter}${Date.now()}`): string {
    const xml = this.assertionXml(o, id);
    return this.sign(xml, `//*[@ID='${id}']`, `//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']`, o.key ?? this.key);
  }

  responseXml(o: ResponseOptions, innerAssertion?: string): string {
    const id = `_r${++counter}${Date.now()}`;
    const aid = o.assertionId ?? `_a${++counter}${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    let assertion = innerAssertion ?? this.assertionXml(o, aid);
    if (!innerAssertion && o.signAssertion !== false) assertion = this.sign(assertion, `//*[@ID='${aid}']`, `//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']`, o.key ?? this.key);
    const irt = o.requestId ? ` InResponseTo="${o.requestId}"` : '';
    const dest = o.destination === null ? '' : ` Destination="${esc(o.destination ?? o.acsUrl)}"`;
    let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(Date.now())}"${dest}${irt}>`
      + `<saml:Issuer>${esc(o.issuer ?? this.entityId)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
    if (o.signResponse) xml = this.sign(xml, `//*[@ID='${id}']`, `/*[local-name(.)='Response']/*[local-name(.)='Issuer']`, o.key ?? this.key);
    return xml;
  }

  static b64(xml: string): string {
    return Buffer.from(xml, 'utf8').toString('base64');
  }
}
