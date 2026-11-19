import { describe, test, expect, beforeAll } from 'bun:test';
import { FakeSamlIdp, makeKeyPair } from '../../tests/fake-saml-idp';
import { validateSamlResponse, type ReplayStore, type SamlSpConfig } from './saml-validator';
import type { SamlMappingConfig } from './saml-xml';

const mapping: SamlMappingConfig = { emailAttribute: null, displayNameAttribute: null, usernameAttribute: null, groupsAttribute: null, syncGroups: true, nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' };
const ACS = 'https://sp.test/rest/auth/1/saml/x/acs';
const SP = 'https://sp.test/rest/auth/1/saml/x/metadata';

describe('validateSamlResponse', () => {
  let idp: FakeSamlIdp;
  let cfg: SamlSpConfig;
  const memoryReplay = (): ReplayStore => {
    const seen = new Set<string>();
    return { async saveIfAbsent(k) { if (seen.has(k)) return false; seen.add(k); return true; } };
  };
  const run = (xml: string, replay: ReplayStore, id = '_req1') =>
    validateSamlResponse({ samlResponse: FakeSamlIdp.b64(xml), cfg, mapping, expectedRequestId: id, replay });
  const rejects = async (p: Promise<unknown>, code: string) => {
    let err: any = null;
    try { await p; } catch (e) { err = e; }
    expect(err?.code).toBe(code);
  };

  beforeAll(async () => {
    idp = new FakeSamlIdp(await makeKeyPair());
    cfg = { spEntityId: SP, acsUrl: ACS, idpEntityId: idp.entityId, idpSsoUrl: idp.ssoUrl, idpCertificates: idp.key.certificate, nameIdFormat: mapping.nameIdFormat };
  });

  test('accepts a valid response and returns the mapped profile', async () => {
    const r = await run(idp.responseXml({ requestId: '_req1', acsUrl: ACS, audience: SP, groups: ['a'] }), memoryReplay());
    expect(r.profile).toMatchObject({ email: 'jane@example.com', name: 'Jane Doe', groups: ['a'] });
    expect(r.assertion.audiences).toEqual([SP]);
  });

  test('the same assertion ID is accepted once only (replay store)', async () => {
    const replay = memoryReplay();
    const xml = idp.responseXml({ requestId: '_req1', acsUrl: ACS, audience: SP, assertionId: '_fixed-assertion-id' });
    await run(xml, replay);
    await rejects(run(xml, replay), 'replayed');
    await run(xml, memoryReplay()); // the store is the only memory
  });

  test('refuses a different expected request ID, an unsigned response and a foreign key', async () => {
    const xml = idp.responseXml({ requestId: '_req1', acsUrl: ACS, audience: SP });
    await rejects(run(xml, memoryReplay(), '_other'), 'in_response_to');
    await rejects(run(idp.responseXml({ requestId: '_req1', acsUrl: ACS, audience: SP, signAssertion: false }), memoryReplay()), 'signature');
    const rogue = await makeKeyPair('rogue');
    await rejects(run(idp.responseXml({ requestId: '_req1', acsUrl: ACS, audience: SP, key: rogue }), memoryReplay()), 'signature');
  });

  test('refuses non-Response roots and bad destinations', async () => {
    await rejects(run('<Foo/>', memoryReplay()), 'invalid_response');
    await rejects(run(idp.responseXml({ requestId: '_req1', acsUrl: ACS, audience: SP, destination: 'https://evil.test/acs' }), memoryReplay()), 'destination');
  });

  test('replay keys are scoped to the issuer and expire with the assertion', async () => {
    const keys: Array<[string, number]> = [];
    const store: ReplayStore = { async saveIfAbsent(k, exp) { keys.push([k, exp]); return true; } };
    await run(idp.responseXml({ requestId: '_req1', acsUrl: ACS, audience: SP }), store);
    expect(keys).toHaveLength(1);
    expect(keys[0][0]).toContain(idp.entityId);
    expect(keys[0][1]).toBeGreaterThan(Date.now());
  });
});
