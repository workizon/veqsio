import { describe, expect, test } from 'bun:test'
import { assertEgressUrl, checkEgressUrl, EgressError } from './outbound'

// Self-hosted default: the private-range guard is OFF, but metadata / link-local targets must still be refused.
const selfHosted = {} as NodeJS.ProcessEnv
const lookupTo = (address: string) => (async () => [{ address, family: 4 }]) as any
const lookupFails = (async () => { throw new Error('ENOTFOUND') }) as any

describe('egress guard with the private-range check off', () => {
  test('a public-looking name resolving to the cloud metadata address is refused', async () => {
    await expect(assertEgressUrl('https://x.attacker.example/', selfHosted, lookupTo('169.254.169.254'))).rejects.toThrow(EgressError)
  })
  test('a name resolving to link-local IPv6 is refused', async () => {
    await expect(assertEgressUrl('https://x.attacker.example/', selfHosted, lookupTo('fe80::1'))).rejects.toThrow(EgressError)
  })
  test('internal services stay reachable for self-hosted installs', async () => {
    await expect(assertEgressUrl('http://intranet.example/hook', selfHosted, lookupTo('10.0.0.5'))).resolves.toBeInstanceOf(URL)
  })
  test('a lookup failure is not fatal (offline installs)', async () => {
    await expect(assertEgressUrl('https://hooks.example/', selfHosted, lookupFails)).resolves.toBeInstanceOf(URL)
  })
  test('a trailing dot does not bypass the metadata host name list', () => {
    expect(() => checkEgressUrl('http://metadata.google.internal./computeMetadata/v1/', selfHosted)).toThrow(EgressError)
  })
})
