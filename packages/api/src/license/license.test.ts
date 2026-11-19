import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { hasFeature, refreshLicense, setLicensePublicKeysForTests } from './index'
import { isEnterpriseFeature, PLAN_FEATURES } from './features'
import { decodeToken, verifyLicense, type LicensePayload } from './verify'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const other = generateKeyPairSync('ed25519')
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const keys = [{ kid: 'k1', pem }]

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function issue(over: Partial<LicensePayload> = {}, signer = privateKey): string {
  const payload: LicensePayload = {
    v: 1, kid: 'k1', id: 'lic-1', customer: 'Acme', plan: 'enterprise', features: [],
    issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', ...over,
  }
  const head = `VQL1.${b64u(JSON.stringify(payload))}`
  return `${head}.${b64u(sign(null, Buffer.from(head), signer))}`
}

const at = (s: string) => new Date(s)

describe('licence verification', () => {
  test('no key means community', () => {
    expect(verifyLicense(null, keys).state).toBe('none')
    expect(verifyLicense('  ', keys).plan).toBe('community')
  })

  test('a valid key is accepted and expands plan features', () => {
    const info = verifyLicense(issue(), keys, at('2026-06-01'))
    expect(info.state).toBe('valid')
    expect(info.customer).toBe('Acme')
    expect(info.features).toContain('sso_saml')
    const team = verifyLicense(issue({ plan: 'team', features: ['scim'] }), keys, at('2026-06-01'))
    expect(team.features).toEqual(expect.arrayContaining([...PLAN_FEATURES.team, 'scim']))
    expect(team.features).not.toContain('sso_saml')
  })

  test('tampering with the payload invalidates the signature', () => {
    const t = issue({ plan: 'team' })
    const [p, body, sig] = t.split('.')
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString())
    forged.plan = 'enterprise'
    const info = verifyLicense([p, b64u(JSON.stringify(forged)), sig].join('.'), keys, at('2026-06-01'))
    expect(info.state).toBe('invalid')
    expect(info.features).toEqual([])
  })

  test('a key signed by someone else is rejected', () => {
    expect(verifyLicense(issue({}, other.privateKey), keys, at('2026-06-01')).state).toBe('invalid')
  })

  test('unknown kid, malformed and wrong-prefix tokens are invalid', () => {
    expect(verifyLicense(issue({ kid: 'nope' }), keys, at('2026-06-01')).state).toBe('invalid')
    expect(verifyLicense('garbage', keys).state).toBe('invalid')
    expect(verifyLicense(issue().replace('VQL1', 'VQL2'), keys).state).toBe('invalid')
    expect(decodeToken('VQL1.%%%.xx')).toBeNull()
  })

  test('no configured public keys rejects everything', () => {
    expect(verifyLicense(issue(), [], at('2026-06-01')).state).toBe('invalid')
  })

  test('expiry: grace period keeps features, afterwards they switch off but nothing else changes', () => {
    const token = issue({ expiresAt: '2026-06-01T00:00:00Z', graceDays: 10 })
    expect(verifyLicense(token, keys, at('2026-06-01T00:00:00Z')).state).toBe('valid')
    const grace = verifyLicense(token, keys, at('2026-06-05'))
    expect(grace.state).toBe('grace')
    expect(grace.features).toContain('sso_saml')
    const expired = verifyLicense(token, keys, at('2026-06-20'))
    expect(expired.state).toBe('expired')
    expect(expired.features).toEqual([])
    expect(expired.plan).toBe('community')
  })

  test('perpetual licences (no expiry) stay valid', () => {
    expect(verifyLicense(issue({ expiresAt: null }), keys, at('2099-01-01')).state).toBe('valid')
  })

  test('instance binding is enforced only when both sides carry an id', () => {
    const bound = issue({ instance: 'inst-a' })
    expect(verifyLicense(bound, keys, at('2026-06-01'), { instanceId: 'inst-a' }).state).toBe('valid')
    expect(verifyLicense(bound, keys, at('2026-06-01'), { instanceId: 'inst-b' }).state).toBe('invalid')
    expect(verifyLicense(bound, keys, at('2026-06-01')).state).toBe('valid')
  })
})

describe('feature gate', () => {
  test('community features are always on; enterprise features follow the licence', async () => {
    expect(isEnterpriseFeature('sso_saml')).toBe(true)
    expect(isEnterpriseFeature('boards')).toBe(false)
    expect(hasFeature('boards')).toBe(true)

    setLicensePublicKeysForTests(keys)
    const saved = process.env.VEQSIO_LICENSE_KEY
    try {
      process.env.VEQSIO_LICENSE_KEY = ''
      process.env.VEQSIO_LICENSE_KEY = issue({ plan: 'team' })
      await refreshLicense(at('2026-06-01'))
      expect(hasFeature('audit_export')).toBe(true)
      expect(hasFeature('sso_saml')).toBe(false)

      process.env.VEQSIO_LICENSE_KEY = issue({ plan: 'enterprise' })
      await refreshLicense(at('2026-06-01'))
      expect(hasFeature('sso_saml')).toBe(true)

      delete process.env.VEQSIO_LICENSE_KEY
      await refreshLicense(at('2026-06-01'))
      expect(hasFeature('sso_saml')).toBe(false)
    } finally {
      setLicensePublicKeysForTests(null)
      if (saved === undefined) delete process.env.VEQSIO_LICENSE_KEY
      else process.env.VEQSIO_LICENSE_KEY = saved
      await refreshLicense()
    }
  })
})
