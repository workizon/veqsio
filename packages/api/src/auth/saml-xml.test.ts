import { describe, test, expect } from 'bun:test';
import { assertSafeXml, decodeSamlResponse, extractAssertion, mapSamlProfile, normalizeEndpoint, peekResponseRoot, splitPemCertificates, MAX_SAML_RESPONSE_B64, type SamlError, type SamlMappingConfig } from './saml-xml';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as SamlError).code; } };
const cfg: SamlMappingConfig = { emailAttribute: null, displayNameAttribute: null, usernameAttribute: null, groupsAttribute: null, syncGroups: true, nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' };

describe('decodeSamlResponse / assertSafeXml', () => {
  test('accepts a plain document and a declaration', () => {
    expect(decodeSamlResponse(b64('<a><b/></a>'))).toBe('<a><b/></a>');
    expect(code(() => decodeSamlResponse(b64('<?xml version="1.0" encoding="UTF-8"?><a/>')))).toBeNull();
    const w = b64('<a/>');
    expect(decodeSamlResponse(`${w.slice(0, 4)}\n${w.slice(4)}`)).toBe('<a/>'); // line-wrapped base64
  });
  test('rejects DTDs, entities and processing instructions', () => {
    expect(code(() => assertSafeXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'))).toBe('dtd_forbidden');
    expect(code(() => assertSafeXml('<!doctype a><a/>'))).toBe('dtd_forbidden');
    expect(code(() => assertSafeXml('<a>&custom;</a>'))).toBe('dtd_forbidden');
    expect(code(() => assertSafeXml('<a>&amp;&lt;&#65;&#x41;</a>'))).toBeNull();
    expect(code(() => assertSafeXml('<?xml-stylesheet href="x"?><a/>'))).toBe('invalid_xml');
    expect(code(() => assertSafeXml('<a/><?pi x?>'))).toBe('invalid_xml');
  });
  test('rejects bad base64, UTF-16, non-XML and size/structure abuse', () => {
    expect(code(() => decodeSamlResponse(''))).toBe('invalid_request');
    expect(code(() => decodeSamlResponse(undefined))).toBe('invalid_request');
    expect(code(() => decodeSamlResponse('***'))).toBe('invalid_request');
    expect(code(() => decodeSamlResponse(Buffer.from('<a/>', 'utf16le').toString('base64')))).toBe('invalid_xml');
    expect(code(() => decodeSamlResponse(b64('hello')))).toBe('invalid_xml');
    expect(code(() => decodeSamlResponse('A'.repeat(MAX_SAML_RESPONSE_B64 + 4)))).toBe('payload_too_large');
    expect(code(() => assertSafeXml('<a>'.repeat(100)))).toBe('invalid_xml');
    expect(code(() => assertSafeXml(`<r>${'<i/>'.repeat(5000)}</r>`))).toBe('invalid_xml');
  });
});

const ASSERTION = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1"><saml:Issuer>https://idp</saml:Issuer>
<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">Jane@Example.com</saml:NameID>
<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData Recipient="https://sp/acs" InResponseTo="_r1" NotOnOrAfter="2030-01-01T00:00:00Z"/></saml:SubjectConfirmation>
<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:holder-of-key"><saml:SubjectConfirmationData Recipient="https://evil/acs"/></saml:SubjectConfirmation></saml:Subject>
<saml:Conditions NotOnOrAfter="2030-01-01T00:00:00Z"><saml:AudienceRestriction><saml:Audience>https://sp</saml:Audience></saml:AudienceRestriction></saml:Conditions>
<saml:AuthnStatement SessionIndex="s1"/>
<saml:AttributeStatement>
<saml:Attribute Name="groups"><saml:AttributeValue>eng</saml:AttributeValue><saml:AttributeValue>ops &amp; dev</saml:AttributeValue></saml:Attribute>
<saml:Attribute Name="urn:oid:2.5.4.42" FriendlyName="givenName"><saml:AttributeValue>Jane</saml:AttributeValue></saml:Attribute>
<saml:Attribute Name="urn:oid:2.5.4.4"><saml:AttributeValue xsi:type="xs:string" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">Doe</saml:AttributeValue></saml:Attribute>
</saml:AttributeStatement></saml:Assertion>`;

describe('extractAssertion / mapSamlProfile', () => {
  const a = extractAssertion(ASSERTION);
  test('reads the fields', () => {
    expect(a.id).toBe('_a1');
    expect(a.issuer).toBe('https://idp');
    expect(a.nameId).toBe('Jane@Example.com');
    expect(a.audiences).toEqual(['https://sp']);
    expect(a.bearer).toEqual([{ recipient: 'https://sp/acs', inResponseTo: '_r1', notOnOrAfter: '2030-01-01T00:00:00Z' }]); // holder-of-key ignored
    expect(a.hasAuthnStatement).toBe(true);
    expect(a.attributes.groups).toEqual(['eng', 'ops & dev']);
    expect(a.attributes.givenName).toEqual(['Jane']); // FriendlyName alias
  });
  test('rejects a non-assertion root and unsafe input', () => {
    expect(code(() => extractAssertion('<Response/>'))).toBe('invalid_response');
    expect(code(() => extractAssertion('<!DOCTYPE a><a/>'))).toBe('dtd_forbidden');
  });
  test('defaults: NameID e-mail, first+last name, groups', () => {
    expect(mapSamlProfile(a, cfg)).toEqual({ subject: 'Jane@Example.com', email: 'jane@example.com', name: 'Jane Doe', username: null, groups: ['eng', 'ops & dev'] });
  });
  test('explicit attribute names win, group sync can be off, bad e-mail is dropped', () => {
    const x = { nameId: 'u1', nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', attributes: { mail2: ['A@B.org'], dn: ['Name'], u: ['uu'], g: ['x', 'x', ' y '], email: ['wrong@example.com'] } };
    expect(mapSamlProfile(x, { ...cfg, emailAttribute: 'mail2', displayNameAttribute: 'dn', usernameAttribute: 'u', groupsAttribute: 'g' })).toEqual({ subject: 'u1', email: 'a@b.org', name: 'Name', username: 'uu', groups: ['x', 'y'] });
    expect(mapSamlProfile(x, { ...cfg, syncGroups: false }).groups).toEqual([]);
    expect(mapSamlProfile({ ...x, attributes: { email: ['not-an-email'] } }, cfg).email).toBeNull();
    expect(code(() => mapSamlProfile({ nameId: null, nameIdFormat: null, attributes: {} }, cfg))).toBe('invalid_response');
  });
});

describe('misc helpers', () => {
  test('normalizeEndpoint', () => {
    expect(normalizeEndpoint('HTTPS://Sp.Example.com:443/a/b/?x=1#f')).toBe('https://sp.example.com/a/b');
    expect(normalizeEndpoint('https://sp.example.com/a/b')).not.toBe(normalizeEndpoint('https://sp.example.com/a/c'));
    expect(normalizeEndpoint('https://sp.example.com/a')).not.toBe(normalizeEndpoint('https://evil.example.com/a'));
  });
  test('peekResponseRoot', () => {
    expect(peekResponseRoot('<samlp:Response xmlns:samlp="x" Destination="https://sp/acs"/>')).toEqual({ root: 'Response', destination: 'https://sp/acs' });
    expect(peekResponseRoot('<Other/>').root).toBe('Other');
  });
  test('splitPemCertificates', () => {
    const pem = (b: string) => `-----BEGIN CERTIFICATE-----\n${b}\n-----END CERTIFICATE-----`;
    expect(splitPemCertificates(`${pem('AAAA')}\n\n${pem('BBBB')}`)).toHaveLength(2);
    expect(splitPemCertificates('junk')).toEqual([]);
    expect(splitPemCertificates('A'.repeat(200))[0]).toContain('BEGIN CERTIFICATE'); // bare base64 from IdP metadata
  });
});
