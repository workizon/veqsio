import { describe, expect, it } from 'bun:test'
import { licenceNotice } from '../lib/licence-notice'

const now = Date.parse('2026-06-01T00:00:00Z')
const at = (days: number) => new Date(now + days * 86_400_000).toISOString()

describe('licenceNotice', () => {
  it('says nothing for the free edition or a healthy licence', () => {
    expect(licenceNotice(undefined, now)).toBeNull()
    expect(licenceNotice({ state: 'none', expiresAt: null }, now)).toBeNull()
    expect(licenceNotice({ state: 'valid', expiresAt: at(200) }, now)).toBeNull()
  })
  it('warns during the last 30 days and in the grace period, is critical when expired or invalid', () => {
    expect(licenceNotice({ state: 'valid', expiresAt: at(10) }, now)).toMatchObject({ level: 'warning', message: expect.stringContaining('10 days') })
    expect(licenceNotice({ state: 'valid', expiresAt: at(1) }, now)?.message).toContain('1 day.')
    expect(licenceNotice({ state: 'grace', expiresAt: at(-3) }, now)).toMatchObject({ level: 'warning' })
    expect(licenceNotice({ state: 'expired', expiresAt: at(-30) }, now)).toMatchObject({ level: 'critical' })
    expect(licenceNotice({ state: 'invalid', expiresAt: null }, now)).toMatchObject({ level: 'critical' })
  })
})
