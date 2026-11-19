import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { isBlockedInCloud, isCloud } from './mode'
import { blockedByPlatform, emailBudget, exceedsStorage, planLimits } from './limits'
import { tokenMatches } from './token'
import { SETTINGS } from '../settings/instance'
import { assertEgressUrl, checkEgressUrl, egressGuardOn, EgressError, outboundFetch } from '../security/outbound'
import { assess, compareVersions, verifyManifest } from '../updates/releases'

const cloud = { VEQSIO_CLOUD: '1' } as NodeJS.ProcessEnv

describe('cloud mode lock-down', () => {
  test('self-host-only endpoints are refused in cloud mode, reads of normal data are not', () => {
    expect(isBlockedInCloud('PUT', '/rest/api/2/admin/license')).toBe(true)
    expect(isBlockedInCloud('DELETE', '/rest/api/2/admin/license')).toBe(true)
    expect(isBlockedInCloud('POST', '/rest/api/2/admin/system/backup')).toBe(true)
    expect(isBlockedInCloud('GET', '/rest/api/2/admin/system/backup')).toBe(true)
    expect(isBlockedInCloud('PUT', '/rest/api/2/admin/system/mail')).toBe(true)
    expect(isBlockedInCloud('POST', '/rest/api/2/admin/system/mail/test')).toBe(true)
    expect(isBlockedInCloud('GET', '/rest/api/2/admin/health-check')).toBe(true)
    expect(isBlockedInCloud('GET', '/rest/api/2/admin/license')).toBe(false) // plan view stays readable
    expect(isBlockedInCloud('GET', '/rest/api/2/issue/ABC-1')).toBe(false)
    expect(isBlockedInCloud('PUT', '/rest/api/2/admin/settings')).toBe(false)
  })
  test('only VEQSIO_CLOUD=1 turns it on', () => {
    expect(isCloud({ VEQSIO_CLOUD: '1' } as any)).toBe(true)
    expect(isCloud({ VEQSIO_CLOUD: 'true' } as any)).toBe(false)
    expect(isCloud({} as any)).toBe(false)
  })
})

describe('plan limits', () => {
  test('no variables: no limits (self-hosted)', () => {
    expect(planLimits({} as any)).toEqual({ users: null, storageBytes: null, attachmentMaxBytes: null, emailsPerHour: null, apiRequestsPerMinute: null })
  })
  test('control plane variables', () => {
    const l = planLimits({ VEQSIO_CLOUD: '1', VEQSIO_LIMIT_USERS: '25', VEQSIO_LIMIT_STORAGE_MB: '1024', RATE_LIMIT_USER_MAX: '300' } as any)
    expect(l.users).toBe(25)
    expect(l.storageBytes).toBe(1024 * 1024 * 1024)
    expect(l.attachmentMaxBytes).toBe(25 * 1024 * 1024) // cloud default
    expect(l.emailsPerHour).toBe(200)
    expect(l.apiRequestsPerMinute).toBe(300)
  })
  test('garbage is ignored, not treated as zero', () => {
    expect(planLimits({ VEQSIO_LIMIT_USERS: 'abc' } as any).users).toBeNull()
    expect(planLimits({ VEQSIO_LIMIT_USERS: '0' } as any).users).toBeNull()
  })
  test('storage decision', () => {
    expect(exceedsStorage(null, 1e12, 1e9)).toBe(false)
    expect(exceedsStorage(1000, 900, 100)).toBe(false)
    expect(exceedsStorage(1000, 900, 101)).toBe(true)
  })
  test('e-mail budget', () => {
    expect(emailBudget(null, 999, 10)).toBe(10)
    expect(emailBudget(200, 190, 10)).toBe(10)
    expect(emailBudget(200, 195, 10)).toBe(5)
    expect(emailBudget(200, 200, 10)).toBe(0)
    expect(emailBudget(200, 500, 10)).toBe(0)
  })
  test('executables refused only on cloud tenants', () => {
    expect(blockedByPlatform('setup.EXE', cloud)).toMatch(/not allowed/)
    expect(blockedByPlatform('report.pdf', cloud)).toBeNull()
    expect(blockedByPlatform('setup.exe', {} as any)).toBeNull()
  })
})

describe('metering token', () => {
  test('constant-time compare semantics', () => {
    expect(tokenMatches('s3cret', 's3cret')).toBe(true)
    expect(tokenMatches('s3cret', 's3cre')).toBe(false)
    expect(tokenMatches('', 's3cret')).toBe(false)
    expect(tokenMatches(undefined, 's3cret')).toBe(false)
    expect(tokenMatches('x', undefined)).toBe(false)
  })
})

describe('instance settings: automatic updates', () => {
  const def = (k: string) => SETTINGS.find((s) => s.key === k)!
  test('catalogue', () => {
    expect(def('autoUpdateMode').options).toEqual(['off', 'security', 'all'])
    expect(def('autoUpdateMode').default).toBe('off')
    expect(def('autoUpdateMode').cloudDefault).toBe('all')
    expect(def('autoUpdateWindowHour').min).toBe(0)
    expect(def('autoUpdateWindowHour').max).toBe(23)
    expect(def('autoUpdateWindowDay').options).toContain('any')
    expect(def('autoUpdateNotifyAdmins').type).toBe('bool')
  })
})

describe('egress guard', () => {
  const lookupTo = (address: string) => (async () => [{ address, family: 4 }]) as any
  test('metadata and link-local are always refused', () => {
    expect(() => checkEgressUrl('http://169.254.169.254/latest/meta-data', {} as any)).toThrow(EgressError)
    expect(() => checkEgressUrl('http://metadata.google.internal/', {} as any)).toThrow(EgressError)
    expect(() => checkEgressUrl('http://[fe80::1]/', {} as any)).toThrow(EgressError)
  })
  test('private ranges: allowed self-hosted, refused when the guard is on', () => {
    expect(egressGuardOn({} as any)).toBe(false)
    expect(() => checkEgressUrl('http://10.0.0.5/hook', {} as any)).not.toThrow()
    for (const u of ['http://10.0.0.5/', 'http://127.0.0.1:3000/', 'http://localhost/', 'http://192.168.1.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://172.16.0.1/', 'http://100.64.0.1/', 'http://db.internal/'])
      expect(() => checkEgressUrl(u, cloud)).toThrow(EgressError)
    expect(() => checkEgressUrl('https://hooks.example.com/x', cloud)).not.toThrow()
    expect(egressGuardOn({ VEQSIO_BLOCK_PRIVATE_EGRESS: '1' } as any)).toBe(true)
  })
  test('the allow switch is ignored in cloud mode', () => {
    expect(egressGuardOn({ VEQSIO_CLOUD: '1', VEQSIO_ALLOW_PRIVATE_EGRESS: '1' } as any)).toBe(true)
  })
  test('schemes and credentials', () => {
    expect(() => checkEgressUrl('file:///etc/passwd', cloud)).toThrow(EgressError)
    expect(() => checkEgressUrl('gopher://x/', cloud)).toThrow(EgressError)
    expect(() => checkEgressUrl('https://user:pw@example.com/', cloud)).toThrow(EgressError)
  })
  test('a public name that resolves to an internal address is refused (DNS check)', async () => {
    await expect(assertEgressUrl('https://evil.example.com/', cloud, lookupTo('127.0.0.1'))).rejects.toThrow(EgressError)
    await expect(assertEgressUrl('https://evil.example.com/', cloud, lookupTo('169.254.169.254'))).rejects.toThrow(EgressError)
    await expect(assertEgressUrl('https://ok.example.com/', cloud, lookupTo('93.184.216.34'))).resolves.toBeInstanceOf(URL)
  })
  test('redirect to an internal host is refused', async () => {
    let calls = 0
    const fetchImpl = (async (u: string) => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3000/admin' } }) }) as any
    await expect(outboundFetch('http://203.0.113.5/hook', { method: 'POST', body: '{}' }, { fetchImpl, env: cloud })).rejects.toThrow(EgressError)
    expect(calls).toBe(1)
  })
  test('redirects are followed within the limit and POST becomes GET on 302', async () => {
    const seen: string[] = []
    const fetchImpl = (async (u: string, init: any) => {
      seen.push(`${init.method} ${u}`)
      return seen.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://203.0.113.9/next' } }) : new Response('ok')
    }) as any
    const res = await outboundFetch('https://203.0.113.5/a', { method: 'POST', body: 'x' }, { fetchImpl, env: cloud })
    expect(await res.text()).toBe('ok')
    expect(seen).toEqual(['POST https://203.0.113.5/a', 'GET https://203.0.113.9/next'])
  })
})

describe('signed release manifest', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keys = [{ kid: 'r1', pem }]
  const mk = (payload: object, kid = 'r1') => {
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return { kid, payload: p, signature: sign(null, Buffer.from(`VQR1.${p}`), privateKey).toString('base64url') }
  }
  const payload = { v: 1, latest: '1.3.0', releases: [
    { version: '1.3.0', security: false, notes: 'features', minFrom: '1.1.0' },
    { version: '1.2.1', security: true, notes: 'fix' },
    { version: '1.0.0', security: false, notes: 'old' },
  ] }
  test('valid manifest verifies', () => { expect(verifyManifest(mk(payload), keys).ok).toBe(true) })
  test('tampered payload, wrong key id and malformed documents are rejected', () => {
    const doc = mk(payload)
    expect(verifyManifest({ ...doc, payload: Buffer.from(JSON.stringify({ ...payload, latest: '9.9.9' })).toString('base64url') }, keys)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyManifest(mk(payload, 'other'), keys)).toEqual({ ok: false, reason: 'unknown_kid' })
    expect(verifyManifest({ nope: 1 }, keys)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyManifest(mk(payload), [])).toEqual({ ok: false, reason: 'unknown_kid' })
  })
  test('unsigned manifest signed by a different key is rejected', () => {
    const other = generateKeyPairSync('ed25519')
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const forged = { kid: 'r1', payload: p, signature: sign(null, Buffer.from(`VQR1.${p}`), other.privateKey).toString('base64url') }
    expect(verifyManifest(forged, keys)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  test('version comparison and assessment', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.2.0', '1.2')).toBe(0)
    expect(compareVersions('1.2.0-rc1', '1.2.0')).toBe(0)
    const m = (verifyManifest(mk(payload), keys) as any).manifest
    const a = assess(m, '1.2.0')
    expect(a.updateAvailable).toBe(true)
    expect(a.securityUpdate).toBe(true)
    expect(a.canUpgradeDirectly).toBe(true)
    expect(a.notes.map((r) => r.version)).toEqual(['1.3.0', '1.2.1'])
    expect(assess(m, '1.3.0').updateAvailable).toBe(false)
    expect(assess(m, '1.0.5').canUpgradeDirectly).toBe(false) // below minFrom 1.1.0
  })
})
