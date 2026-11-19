import { describe, test, expect } from 'bun:test'
import {
  activeDirectoryPreset, certificateStatus, emptyLdapForm, emptySamlForm, ldapPayload, ldapProblem, samlPayload, samlProblem, skipReason,
  splitDomains, splitList, ssoErrorMessage, syncSummary,
} from '../lib/sso-forms'
import { allPages } from '../lib/routes'
import { searchAdmin } from '../lib/admin-helper'

const CERT = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'

describe('splitList / splitDomains', () => {
  test('splits on commas, semicolons and new lines, trims and de-duplicates', () => {
    expect(splitList('a, b;c\n d ,, a')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitList('')).toEqual([])
    expect(splitList('Group One, Group Two')).toEqual(['Group One', 'Group Two'])
  })
  test('domains accept spaces and are lower-cased', () => {
    expect(splitDomains('Example.com  corp.example,EXAMPLE.com')).toEqual(['example.com', 'corp.example'])
  })
})

describe('SAML form', () => {
  const base = { ...emptySamlForm, name: ' Corp ', slug: 'corp', idpEntityId: 'https://idp/e', idpSsoUrl: 'https://idp/sso', idpCertificates: CERT }
  test('payload: empty attribute names become null (defaults), lists are parsed, slug only on create', () => {
    const p = samlPayload({ ...base, emailAttribute: ' ', groupsAttribute: 'roles', defaultGroups: 'a, b', allowedDomains: 'X.com y.com' })
    expect(p).toMatchObject({ name: 'Corp', emailAttribute: null, groupsAttribute: 'roles', defaultGroups: ['a', 'b'], allowedDomains: ['x.com', 'y.com'], slug: 'corp' })
    expect(samlPayload({ ...base, id: 3 }).slug).toBeUndefined()
  })
  test('signing key and certificate are sent only when signing is on and filled in', () => {
    expect(samlPayload({ ...base, spSigningKey: 'K', spSigningCertificate: 'C' }).spSigningKey).toBeUndefined()
    const p = samlPayload({ ...base, signRequests: true, spSigningKey: 'K', spSigningCertificate: 'C' })
    expect(p).toMatchObject({ spSigningKey: 'K', spSigningCertificate: 'C' })
    expect(samlPayload({ ...base, id: 1, signRequests: true, hasSigningKey: true, spSigningCertificate: 'C' }).spSigningKey).toBeUndefined() // keep the stored key
  })
  test('problems are reported in order', () => {
    expect(samlProblem({ ...base, name: '' })).toContain('Display name')
    expect(samlProblem({ ...base, slug: 'A' })).toContain('Slug')
    expect(samlProblem({ ...base, idpSsoUrl: 'nope' })).toContain('SSO URL')
    expect(samlProblem({ ...base, idpCertificates: 'xyz' })).toContain('certificate')
    expect(samlProblem({ ...base, signRequests: true })).toContain('private key')
    expect(samlProblem({ ...base, signRequests: true, hasSigningKey: true })).toBeNull() // stored key is kept
    expect(samlProblem(base)).toBeNull()
  })
})

describe('certificateStatus', () => {
  const now = Date.parse('2026-06-01T00:00:00Z')
  test('expired, expiring and valid', () => {
    expect(certificateStatus({ validTo: '2026-05-01T00:00:00Z', expired: true }, now).tone).toBe('bad')
    expect(certificateStatus({ validTo: '2026-06-11T00:00:00Z', expired: false }, now)).toEqual({ tone: 'warn', label: 'Expires in 10 days' })
    expect(certificateStatus({ validTo: '2027-06-01T00:00:00Z', expired: false }, now)).toEqual({ tone: 'ok', label: 'Valid until 2027-06-01' })
    expect(certificateStatus(null, now).tone).toBe('bad')
  })
})

describe('LDAP form', () => {
  const base = { ...emptyLdapForm, name: 'Corp', url: 'ldaps://ldap.example.com:636', bindDn: 'cn=svc', bindPassword: 'pw', baseDn: 'dc=example,dc=com' }
  test('payload omits an empty password (keep the stored one) and nulls an empty group base', () => {
    expect(ldapPayload({ ...base, bindPassword: '' }).bindPassword).toBeUndefined()
    expect(ldapPayload(base)).toMatchObject({ bindPassword: 'pw', groupBaseDn: null, syncIntervalMinutes: 360 })
  })
  test('problems', () => {
    expect(ldapProblem(base)).toBeNull()
    expect(ldapProblem({ ...base, url: 'http://x' })).toContain('URL')
    expect(ldapProblem({ ...base, startTls: true })).toContain('StartTLS')
    expect(ldapProblem({ ...base, bindPassword: '' })).toContain('password')
    expect(ldapProblem({ ...base, id: 4, bindPassword: '' })).toBeNull()
    expect(ldapProblem({ ...base, userFilter: 'objectClass=person' })).toContain('parentheses')
    expect(ldapProblem({ ...base, syncIntervalMinutes: 1 })).toContain('interval')
  })
  test('Active Directory preset', () => {
    const ad = activeDirectoryPreset(base)
    expect(ad).toMatchObject({ usernameAttribute: 'sAMAccountName', uniqueIdAttribute: 'objectGUID', nestedGroups: true, name: 'Corp' })
    expect(ad.userFilter.startsWith('(') && ad.userFilter.endsWith(')')).toBe(true)
  })
})

describe('sync preview text', () => {
  const zero = { directoryUsers: 0, create: 0, link: 0, update: 0, reactivate: 0, deactivate: 0, skipped: 0, groupsCreate: 0, membershipsAdd: 0, membershipsRemove: 0 }
  test('lists only non-zero figures', () => {
    expect(syncSummary({ ...zero, create: 3, deactivate: 1, membershipsAdd: 5 })).toEqual(['3 users to create', '1 users to deactivate', '5 memberships to add'])
    expect(syncSummary({ ...zero, create: 2 }, true)).toEqual(['2 users created'])
    expect(syncSummary(zero)).toEqual(['Nothing to change'])
  })
  test('skip reasons are readable and unknown codes pass through', () => {
    expect(skipReason('no_email')).toBe('no email address')
    expect(skipReason('weird')).toBe('weird')
  })
})

describe('ssoErrorMessage', () => {
  test('known, SAML and unknown codes', () => {
    expect(ssoErrorMessage('domain_not_allowed')).toContain('domain')
    expect(ssoErrorMessage('saml_signature')).toContain('signed')
    expect(ssoErrorMessage('saml_something_new')).toBe('The SAML sign-in response was not accepted.')
    expect(ssoErrorMessage('<script>')).toBe('Single sign-on failed')
  })
})

describe('navigation', () => {
  test('SAML and LDAP are reachable from the admin search and the page list', () => {
    expect(allPages().some((p) => p.href === '/admin?tab=saml')).toBe(true)
    expect(allPages().some((p) => p.href === '/admin?tab=ldap')).toBe(true)
    expect(searchAdmin('active directory')[0]?.entry.label).toBe('LDAP / Active Directory')
    expect(searchAdmin('saml')[0]?.entry.label).toBe('SAML single sign-on')
  })
})
