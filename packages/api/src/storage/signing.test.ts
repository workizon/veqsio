import { describe, expect, test } from 'bun:test'
import { isPublicStorageKey, signatureFor, verifySignature } from './signing'

const key = Buffer.from('k'.repeat(32))
const now = Date.now()
const exp = Math.floor(now / 1000) + 900

describe('signed storage links', () => {
  test('a link is valid for its own file until it expires', () => {
    const sig = signatureFor(key, 'attachments/P/P-1/a.png', exp, false)
    expect(verifySignature(key, 'attachments/P/P-1/a.png', exp, false, sig, now)).toBe(true)
    expect(verifySignature(key, 'attachments/P/P-1/a.png', exp, false, sig, now + 901_000)).toBe(false)
  })
  test('not for another file, another expiry, or the inline variant', () => {
    const sig = signatureFor(key, 'attachments/P/P-1/a.png', exp, false)
    expect(verifySignature(key, 'attachments/P/P-1/b.png', exp, false, sig, now)).toBe(false)
    expect(verifySignature(key, 'attachments/P/P-1/a.png', exp + 3600, false, sig, now)).toBe(false)
    expect(verifySignature(key, 'attachments/P/P-1/a.png', exp, true, sig, now)).toBe(false)
  })
  test('junk is refused, and so is an expiry far in the future', () => {
    expect(verifySignature(key, 'x', exp, false, '', now)).toBe(false)
    expect(verifySignature(key, 'x', exp, false, 'zz', now)).toBe(false)
    expect(verifySignature(key, 'x', NaN, false, 'ab', now)).toBe(false)
    const far = Math.floor(now / 1000) + 90 * 86400
    expect(verifySignature(key, 'x', far, false, signatureFor(key, 'x', far, false), now)).toBe(false)
  })
  test('another key does not verify', () => {
    const sig = signatureFor(Buffer.from('z'.repeat(32)), 'k', exp, false)
    expect(verifySignature(key, 'k', exp, false, sig, now)).toBe(false)
  })
  test('only avatars keep a plain link', () => {
    expect(isPublicStorageKey('attachments/users/avatars/abc.png')).toBe(true)
    expect(isPublicStorageKey('attachments/WEB/avatars/abc.png')).toBe(true)
    expect(isPublicStorageKey('attachments/WEB/WEB-1/abc.png')).toBe(false)
    expect(isPublicStorageKey('attachments/WEB/avatars/../WEB-1/abc.png')).toBe(false)
  })
})
