/**
 * Pure helpers for SAML messages: strict pre-parse checks, attribute extraction from a VERIFIED assertion and the
 * mapping of SAML attributes to a Veqsio profile. Nothing here touches the network or the database.
 *
 * Security rule for this file's consumers: `extractAssertion` must only ever be given the XML of an assertion whose
 * signature has already been verified (node-saml's `profile.getAssertionXml()`), never the raw posted response.
 */
import { XMLParser } from 'fast-xml-parser';

/** Largest accepted `SAMLResponse` form value (base64) and decoded document. Real responses are 5-30 KiB. */
export const MAX_SAML_RESPONSE_B64 = 512 * 1024;
export const MAX_SAML_XML = 384 * 1024;
const MAX_ELEMENTS = 4000;
const MAX_DEPTH = 48;

export class SamlError extends Error {
  constructor(public code: string, detail?: string) {
    super(detail ?? code);
    this.name = 'SamlError';
  }
}

/**
 * Decodes the posted base64 and refuses anything that is not a plain, DTD-free UTF-8 XML document:
 *  - oversized payloads,
 *  - DOCTYPE / ENTITY declarations (XXE, billion laughs, quadratic blowup): SAML messages never need a DTD,
 *  - any entity reference other than the five predefined ones and numeric character references,
 *  - UTF-16/UTF-32 or NUL bytes (they hide markup from byte-level checks),
 *  - processing instructions other than the XML declaration,
 *  - absurd element counts or nesting.
 */
export function decodeSamlResponse(b64: unknown): string {
  if (typeof b64 !== 'string' || b64.length === 0) throw new SamlError('invalid_request', 'missing SAMLResponse');
  if (b64.length > MAX_SAML_RESPONSE_B64) throw new SamlError('payload_too_large', 'SAMLResponse too large');
  const compact = b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) throw new SamlError('invalid_request', 'SAMLResponse is not base64');
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length > MAX_SAML_XML) throw new SamlError('payload_too_large', 'decoded SAMLResponse too large');
  if (bytes.includes(0)) throw new SamlError('invalid_xml', 'NUL byte or non UTF-8 encoding');
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SamlError('invalid_xml', 'not valid UTF-8');
  }
  assertSafeXml(xml);
  return xml;
}

export function assertSafeXml(xml: string): void {
  const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  if (!text.trimStart().startsWith('<')) throw new SamlError('invalid_xml', 'not an XML document');
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text) || /<!ELEMENT/i.test(text) || /<!ATTLIST/i.test(text)) {
    throw new SamlError('dtd_forbidden', 'DOCTYPE/ENTITY declarations are not allowed');
  }
  if (/&(?!(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)/.test(text)) {
    throw new SamlError('dtd_forbidden', 'unknown entity reference');
  }
  // Processing instructions: only the XML declaration at the very start is allowed.
  const withoutDecl = text.replace(/^\s*<\?xml\s[^?]*\?>/i, '');
  if (withoutDecl.includes('<?')) throw new SamlError('invalid_xml', 'processing instructions are not allowed');
  // Cheap structural limits (the parser would otherwise be fed arbitrarily deep documents).
  let elements = 0;
  let depth = 0;
  const tag = /<(\/?)([A-Za-z_][^\s>/]*)[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(text))) {
    if (m[1]) depth--;
    else {
      elements++;
      if (!m[3]) depth++;
      if (depth > MAX_DEPTH) throw new SamlError('invalid_xml', 'document nested too deeply');
    }
    if (elements > MAX_ELEMENTS) throw new SamlError('invalid_xml', 'too many elements');
  }
}

/* ------------------------------------------------------------------ */
/*  Assertion extraction                                               */
/* ------------------------------------------------------------------ */

export interface BearerConfirmation {
  recipient: string | null;
  inResponseTo: string | null;
  notOnOrAfter: string | null;
}

export interface ExtractedAssertion {
  id: string | null;
  issuer: string | null;
  nameId: string | null;
  nameIdFormat: string | null;
  audiences: string[];
  conditionsNotOnOrAfter: string | null;
  bearer: BearerConfirmation[];
  hasAuthnStatement: boolean;
  sessionIndex: string | null;
  attributes: Record<string, string[]>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  processEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ['Attribute', 'AttributeValue', 'SubjectConfirmation', 'Audience', 'AudienceRestriction'].includes(name),
});

const asText = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object' && typeof (v as any)['#text'] === 'string') return ((v as any)['#text'] as string).trim() || null;
  return null;
};
const attr = (v: any, name: string): string | null => (v && typeof v === 'object' && typeof v[`@_${name}`] === 'string' ? v[`@_${name}`] : null);
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Parses ONE verified assertion element. */
export function extractAssertion(assertionXml: string): ExtractedAssertion {
  assertSafeXml(assertionXml);
  let doc: any;
  try {
    doc = parser.parse(assertionXml);
  } catch {
    throw new SamlError('invalid_xml', 'assertion is not well-formed');
  }
  const a = doc?.Assertion;
  if (!a || typeof a !== 'object') throw new SamlError('invalid_response', 'verified element is not an Assertion');

  const attributes: Record<string, string[]> = {};
  for (const stmt of arr<any>(a.AttributeStatement)) {
    for (const at of arr<any>(stmt?.Attribute)) {
      const name = attr(at, 'Name');
      if (!name) continue;
      const vals = arr<any>(at.AttributeValue).map(asText).filter((x): x is string => !!x);
      attributes[name] = [...(attributes[name] ?? []), ...vals];
      const friendly = attr(at, 'FriendlyName');
      if (friendly && !(friendly in attributes)) attributes[friendly] = [...vals];
    }
  }

  const subj = a.Subject;
  const bearer: BearerConfirmation[] = [];
  for (const sc of arr<any>(subj?.SubjectConfirmation)) {
    if (attr(sc, 'Method') !== 'urn:oasis:names:tc:SAML:2.0:cm:bearer') continue;
    const d = sc.SubjectConfirmationData;
    bearer.push({ recipient: attr(d, 'Recipient'), inResponseTo: attr(d, 'InResponseTo'), notOnOrAfter: attr(d, 'NotOnOrAfter') });
  }

  const audiences: string[] = [];
  for (const r of arr<any>(a.Conditions?.AudienceRestriction)) for (const au of arr<any>(r?.Audience)) { const t = asText(au); if (t) audiences.push(t); }

  const authn = a.AuthnStatement;
  return {
    id: attr(a, 'ID'),
    issuer: asText(a.Issuer),
    nameId: asText(subj?.NameID),
    nameIdFormat: attr(subj?.NameID, 'Format'),
    audiences,
    conditionsNotOnOrAfter: attr(a.Conditions, 'NotOnOrAfter'),
    bearer,
    hasAuthnStatement: !!authn,
    sessionIndex: attr(arr<any>(authn)[0], 'SessionIndex'),
    attributes,
  };
}

/** The Destination and root element name of the posted (unverified) response. Only ever used to REJECT. */
export function peekResponseRoot(xml: string): { root: string | null; destination: string | null } {
  try {
    const doc = parser.parse(xml);
    const root = Object.keys(doc).find((k) => !k.startsWith('?'));
    return { root: root ?? null, destination: root ? attr(doc[root], 'Destination') : null };
  } catch {
    return { root: null, destination: null };
  }
}

/* ------------------------------------------------------------------ */
/*  Attribute mapping                                                  */
/* ------------------------------------------------------------------ */

export const DEFAULT_EMAIL_ATTRIBUTES = [
  'email', 'mail', 'emailAddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'urn:mace:dir:attribute-def:mail',
];
export const DEFAULT_NAME_ATTRIBUTES = [
  'displayName', 'name', 'cn',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'urn:oid:2.16.840.1.113730.3.1.241',
  'urn:oid:2.5.4.3',
];
export const DEFAULT_FIRST_NAME_ATTRIBUTES = ['firstName', 'givenName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'urn:oid:2.5.4.42'];
export const DEFAULT_LAST_NAME_ATTRIBUTES = ['lastName', 'surname', 'sn', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'urn:oid:2.5.4.4'];
export const DEFAULT_USERNAME_ATTRIBUTES = [
  'username', 'uid', 'preferred_username', 'sAMAccountName',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
  'urn:oid:0.9.2342.19200300.100.1.1',
];
export const DEFAULT_GROUP_ATTRIBUTES = [
  'groups', 'group', 'memberOf', 'roles', 'eduPersonAffiliation',
  'http://schemas.xmlsoap.org/claims/Group',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
  'urn:oid:1.3.6.1.4.1.5923.1.5.1.1',
];

export interface SamlMappingConfig {
  emailAttribute: string | null;
  displayNameAttribute: string | null;
  usernameAttribute: string | null;
  groupsAttribute: string | null;
  syncGroups: boolean;
  nameIdFormat: string;
}

export interface MappedSamlProfile {
  subject: string;
  email: string | null;
  name: string | null;
  username: string | null;
  groups: string[];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function firstOf(attrs: Record<string, string[]>, names: string[]): string | null {
  for (const n of names) {
    const v = attrs[n]?.[0];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/** Maps a verified assertion to the fields Veqsio needs. An explicit attribute name wins; null falls back to well-known names. */
export function mapSamlProfile(a: Pick<ExtractedAssertion, 'nameId' | 'nameIdFormat' | 'attributes'>, cfg: SamlMappingConfig): MappedSamlProfile {
  if (!a.nameId) throw new SamlError('invalid_response', 'assertion has no NameID');
  const attrs = a.attributes;
  const pick = (explicit: string | null, defaults: string[]) => firstOf(attrs, explicit ? [explicit] : defaults);

  let email = pick(cfg.emailAttribute, DEFAULT_EMAIL_ATTRIBUTES);
  // NameID is the e-mail address when the IdP was asked for (and used) that format.
  if (!email && !cfg.emailAttribute && EMAIL_RE.test(a.nameId) && (a.nameIdFormat ?? cfg.nameIdFormat).endsWith('emailAddress')) email = a.nameId;
  if (email && !EMAIL_RE.test(email)) email = null;

  let name = pick(cfg.displayNameAttribute, DEFAULT_NAME_ATTRIBUTES);
  if (!name && !cfg.displayNameAttribute) {
    const parts = [firstOf(attrs, DEFAULT_FIRST_NAME_ATTRIBUTES), firstOf(attrs, DEFAULT_LAST_NAME_ATTRIBUTES)].filter(Boolean);
    if (parts.length) name = parts.join(' ');
  }
  const username = pick(cfg.usernameAttribute, DEFAULT_USERNAME_ATTRIBUTES);

  let groups: string[] = [];
  if (cfg.syncGroups) {
    const names = cfg.groupsAttribute ? [cfg.groupsAttribute] : DEFAULT_GROUP_ATTRIBUTES;
    const found = names.find((n) => attrs[n]?.length);
    const raw = found ? attrs[found] : [];
    groups = [...new Set(raw.map((g) => g.trim()).filter((g) => g && g.length <= 255))].slice(0, 200);
  }

  return {
    subject: a.nameId.slice(0, 255),
    email: email ? email.toLowerCase().slice(0, 255) : null,
    name: name ? name.slice(0, 255) : null,
    username: username ? username.slice(0, 255) : null,
    groups,
  };
}

/** Strips query and fragment, lower-cases scheme and host, removes the default port and trailing slash for comparing endpoint URLs. */
export function normalizeEndpoint(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return u;
  }
}

/** PEM blocks of a pasted certificate bundle (also accepts bare base64 DER without the armor). */
export function splitPemCertificates(input: string): string[] {
  const text = input.trim();
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (blocks) return blocks.map((b) => b.trim());
  const bare = text.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(bare) && bare.length > 100) {
    return [`-----BEGIN CERTIFICATE-----\n${bare.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`];
  }
  return [];
}
