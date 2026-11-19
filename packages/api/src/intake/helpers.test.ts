import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_FIELDS, LIMITS, canApply, cleanText, generateSlug, isHoneypotTripped, isPlausibleSlug, isSnoozeDue, issueDescription,
  normalizeFields, parseIssueRef, parseSnoozeUntil, validateSubmission,
} from './helpers'

describe('slug', () => {
  test('is long, url safe and unique', () => {
    const a = generateSlug()
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(isPlausibleSlug(a)).toBe(true)
    expect(generateSlug()).not.toBe(a)
  })
  test('rejects short, long and odd values', () => {
    for (const bad of ['', 'TEST', 'a'.repeat(15), 'a'.repeat(65), 'a/b'.repeat(8), 'a b'.repeat(8), null, 5]) expect(isPlausibleSlug(bad)).toBe(false)
  })
})

describe('normalizeFields', () => {
  test('defaults and bad values', () => {
    expect(normalizeFields(undefined)).toEqual(DEFAULT_FIELDS)
    expect(normalizeFields({ name: 'required', email: 'weird', description: 5 })).toEqual({ name: 'required', email: 'optional', description: 'optional' })
  })
})

describe('cleanText', () => {
  test('strips control characters, normalises newlines, caps', () => {
    expect(cleanText('a\u0000b\u0007c\r\nd', 100)).toBe('abc\nd')
    expect(cleanText('  one\n\n two  ', 100, false)).toBe('one two')
    expect(cleanText('x'.repeat(50), 10)).toHaveLength(10)
    expect(cleanText(42, 10)).toBe('')
  })
})

describe('validateSubmission', () => {
  const f = { name: 'optional', email: 'required', description: 'optional' } as const
  test('accepts and normalises', () => {
    const r = validateSubmission({ title: '  Hello  world ', email: 'Pat@Example.COM', name: ' Pat ', description: 'd' }, f)
    expect(r).toEqual({ ok: true, value: { title: 'Hello world', description: 'd', requesterName: 'Pat', requesterEmail: 'pat@example.com' } })
  })
  test('collects every error', () => {
    const r = validateSubmission({ title: '', email: '' }, f)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toEqual(['title is required', 'email is required'])
  })
  test('invalid email and overlong values', () => {
    const r = validateSubmission({ title: 't'.repeat(LIMITS.title + 1), email: 'nope', description: 'x'.repeat(LIMITS.description + 1) }, f)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('|')).toMatch(/title must be at most.*description must be at most.*email is not a valid/)
  })
  test('fields that are off are dropped', () => {
    const r = validateSubmission({ title: 't', name: 'x', description: 'y', email: 'a@b.co' }, { name: 'off', email: 'off', description: 'off' })
    expect(r).toEqual({ ok: true, value: { title: 't', description: '', requesterName: null, requesterEmail: null } })
  })
  test('required description and name', () => {
    const r = validateSubmission({ title: 't' }, { name: 'required', email: 'off', description: 'required' })
    expect(r.ok).toBe(false)
  })
})

test('honeypot', () => {
  expect(isHoneypotTripped(undefined)).toBe(false)
  expect(isHoneypotTripped('')).toBe(false)
  expect(isHoneypotTripped('  ')).toBe(false)
  expect(isHoneypotTripped('http://x')).toBe(true)
  expect(isHoneypotTripped(1)).toBe(true)
})

describe('state machine', () => {
  test('open items can be decided, final ones cannot', () => {
    for (const a of ['accept', 'decline', 'snooze', 'duplicate'] as const) {
      expect(canApply('pending', a)).toBe(true)
      expect(canApply('snoozed', a)).toBe(true)
      expect(canApply('accepted', a)).toBe(false)
      expect(canApply('declined', a)).toBe(false)
      expect(canApply('duplicate', a)).toBe(false)
    }
  })
  test('reopen', () => {
    expect(canApply('declined', 'reopen')).toBe(true)
    expect(canApply('duplicate', 'reopen')).toBe(true)
    expect(canApply('snoozed', 'reopen')).toBe(true)
    expect(canApply('pending', 'reopen')).toBe(false)
    expect(canApply('accepted', 'reopen')).toBe(false)
  })
})

describe('parseSnoozeUntil', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  test('valid, past, far future, garbage', () => {
    expect(parseSnoozeUntil('2026-01-05T00:00:00Z', now).ok).toBe(true)
    expect(parseSnoozeUntil('2025-12-31T00:00:00Z', now)).toEqual({ ok: false, error: 'until must be in the future' })
    expect(parseSnoozeUntil('2030-01-01T00:00:00Z', now).ok).toBe(false)
    expect(parseSnoozeUntil('soon', now).ok).toBe(false)
    expect(parseSnoozeUntil(undefined, now).ok).toBe(false)
  })
  test('isSnoozeDue', () => {
    expect(isSnoozeDue('snoozed', new Date('2025-12-31'), now)).toBe(true)
    expect(isSnoozeDue('snoozed', new Date('2026-02-01'), now)).toBe(false)
    expect(isSnoozeDue('pending', new Date('2025-12-31'), now)).toBe(false)
    expect(isSnoozeDue('snoozed', null, now)).toBe(false)
  })
})

describe('issueDescription / parseIssueRef', () => {
  test('adds provenance', () => {
    const d = issueDescription({ description: 'Text', requesterName: 'Pat', requesterEmail: 'p@x.io', source: 'form' }, 'Note')
    expect(d).toBe('Text\n\nNote\n\n_Submitted via intake (form) by Pat <p@x.io>._')
    expect(issueDescription({ description: '', requesterName: null, requesterEmail: null, source: 'api' })).toBe('_Submitted via intake (api)._')
  })
  test('issue references', () => {
    expect(parseIssueRef('abc-12')).toEqual({ key: 'ABC-12' })
    expect(parseIssueRef(' 7 ')).toEqual({ id: 7 })
    expect(parseIssueRef(7)).toEqual({ id: 7 })
    for (const bad of ['', 'ABC', 'ABC-', '1; drop', 0, -3, 1.5, null, {}]) expect(parseIssueRef(bad)).toBeNull()
  })
})
