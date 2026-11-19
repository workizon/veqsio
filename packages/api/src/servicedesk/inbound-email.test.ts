import { describe, test, expect } from 'bun:test'
import {
  extractIssueKey, stripQuotedReply, normalizeAddress, sanitizeSubject, summaryFromSubject,
  detectAutoReply, cleanBody, isDomainAllowed, normalizeDomains, MAX_BODY_CHARS,
} from './inbound-email'

describe('extractIssueKey', () => {
  test('finds bracketed key in reply subject', () => {
    expect(extractIssueKey('Re: [ABC-123] Printer broken', 'ABC')).toBe('ABC-123')
    expect(extractIssueKey('RE: FW: [abc-7] x', 'ABC')).toBe('ABC-7')
  })
  test('ignores other projects and partial matches', () => {
    expect(extractIssueKey('Re: [XYZ-1] hi', 'ABC')).toBeNull()
    expect(extractIssueKey('XABC-1 hi', 'ABC')).toBeNull()
    expect(extractIssueKey('Printer broken', 'ABC')).toBeNull()
  })
  test('bare key works', () => {
    expect(extractIssueKey('About ABC-42 please', 'ABC')).toBe('ABC-42')
  })
})

describe('stripQuotedReply', () => {
  test('removes > quotes, wrote blocks and signature', () => {
    const body = ['Thanks, that fixed it.', '', 'On Mon, 3 Jun 2024 at 10:00, Support <s@x.com> wrote:', '> Did you try restarting?', '> yes', '', '-- ', 'Jane', 'ACME'].join('\n')
    expect(stripQuotedReply(body)).toBe('Thanks, that fixed it.')
  })
  test('handles wrapped wrote header and Sent from', () => {
    expect(stripQuotedReply('ok\n\nOn Mon, 3 Jun 2024 at 10:00, Support\n<s@x.com> wrote:\n> hi')).toBe('ok')
    expect(stripQuotedReply('ok\nSent from my iPhone\n\nstuff')).toBe('ok')
  })
  test('removes original message marker and inline quote lines', () => {
    expect(stripQuotedReply('a\n> q\nb\n-----Original Message-----\nFrom: x')).toBe('a\nb')
  })
  test('keeps normal text starting with On', () => {
    expect(stripQuotedReply('On Monday the printer broke.\nHelp')).toBe('On Monday the printer broke.\nHelp')
  })
})

describe('normalizeAddress', () => {
  test('parses display name form and lowercases', () => {
    expect(normalizeAddress('Jane Doe <Jane.Doe@Example.COM>')).toBe('jane.doe@example.com')
    expect(normalizeAddress('a@b.co')).toBe('a@b.co')
  })
  test('rejects invalid', () => {
    expect(normalizeAddress('nope')).toBeNull()
    expect(normalizeAddress('a@b')).toBeNull()
    expect(normalizeAddress('a b@c.com')).toBeNull()
    expect(normalizeAddress(42)).toBeNull()
  })
})

describe('subject', () => {
  test('sanitize makes single line and caps', () => {
    expect(sanitizeSubject('a\r\nBcc: evil@x.com\tb')).toBe('a Bcc: evil@x.com b')
    expect(sanitizeSubject('x'.repeat(900))).toHaveLength(500)
  })
  test('summary drops Re: and key', () => {
    expect(summaryFromSubject('Re: Fwd: [ABC-1] Printer', 'ABC')).toBe('Printer')
    expect(summaryFromSubject('   ')).toBe('(no subject)')
  })
})

describe('detectAutoReply', () => {
  test('headers', () => {
    expect(detectAutoReply({ 'Auto-Submitted': 'auto-replied' }, 'hi')).toBe('auto-submitted')
    expect(detectAutoReply({ 'auto-submitted': 'no' }, 'hi')).toBeNull()
    expect(detectAutoReply({ Precedence: 'bulk' }, 'hi')).toBe('precedence')
    expect(detectAutoReply({ Precedence: 'first-class' }, 'hi')).toBeNull()
    expect(detectAutoReply({ 'X-Autoreply': 'yes' }, 'hi')).toBe('x-autoreply')
  })
  test('subjects', () => {
    expect(detectAutoReply({}, 'Out of office: back Monday')).toBe('subject')
    expect(detectAutoReply({}, 'Automatic reply: hi')).toBe('subject')
    expect(detectAutoReply(undefined, 'Printer broken')).toBeNull()
  })
})

describe('cleanBody / domains', () => {
  test('caps body length', () => {
    expect(cleanBody('a'.repeat(MAX_BODY_CHARS * 2)).length).toBe(MAX_BODY_CHARS)
  })
  test('domain allow-list', () => {
    expect(isDomainAllowed('a@x.com', [])).toBe(true)
    expect(isDomainAllowed('a@x.com', ['x.com'])).toBe(true)
    expect(isDomainAllowed('a@sub.x.com', ['x.com'])).toBe(false)
    expect(normalizeDomains([' @X.com ', 'x.com', ''])).toEqual(['x.com'])
  })
})
