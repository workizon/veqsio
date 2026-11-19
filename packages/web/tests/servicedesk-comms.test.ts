import { describe, test, expect } from 'bun:test'
import {
  validateImapForm, describePoll, customerPayload, isNewCustomerEmail, mergeCandidates, parseRequestKey, describeMerge,
  linkOptions, looksLikeEmail, type ImapForm,
} from '../lib/servicedesk-comms'

const form = (o: Partial<ImapForm> = {}): ImapForm => ({
  enabled: false, host: '', port: '993', tls: true, user: '', password: '', folder: 'INBOX', pollSeconds: '300', ...o,
})

describe('validateImapForm', () => {
  test('a disabled default form is valid', () => expect(validateImapForm(form(), false)).toEqual({}))
  test('interval must be at least a minute', () => {
    expect(validateImapForm(form({ pollSeconds: '30' }), false).pollSeconds).toContain('60')
    expect(validateImapForm(form({ pollSeconds: '60' }), false).pollSeconds).toBeUndefined()
    expect(validateImapForm(form({ pollSeconds: 'abc' }), false).pollSeconds).toBeDefined()
    expect(validateImapForm(form({ pollSeconds: '100000' }), false).pollSeconds).toBeDefined()
  })
  test('port range and folder', () => {
    expect(validateImapForm(form({ port: '0' }), false).port).toBeDefined()
    expect(validateImapForm(form({ port: '70000' }), false).port).toBeDefined()
    expect(validateImapForm(form({ folder: '  ' }), false).folder).toBeDefined()
  })
  test('enabling needs host, user and a password (stored one counts)', () => {
    expect(Object.keys(validateImapForm(form({ enabled: true }), false)).sort()).toEqual(['host', 'password', 'user'])
    expect(validateImapForm(form({ enabled: true, host: 'imap.x.io', user: 'a@x.io' }), true)).toEqual({})
    expect(validateImapForm(form({ enabled: true, host: 'imap.x.io', user: 'a@x.io' }), false).password).toBeDefined()
  })
  test('host must look like a host name', () => {
    expect(validateImapForm(form({ host: 'imap://x' }), false).host).toBeDefined()
    expect(validateImapForm(form({ host: 'imap.example.com' }), false).host).toBeUndefined()
  })
})

describe('describePoll', () => {
  const now = Date.parse('2026-01-01T12:00:00Z')
  test('never polled', () => expect(describePoll({ lastPollAt: null, lastStatus: null, lastError: null, lastCount: null }, now)).toEqual({ tone: 'none', text: 'Not polled yet' }))
  test('ok with counts and relative time', () => {
    expect(describePoll({ lastPollAt: '2026-01-01T11:55:00Z', lastStatus: 'ok', lastError: null, lastCount: 3 }, now)).toEqual({ tone: 'ok', text: 'OK 5 min ago, 3 messages processed' })
    expect(describePoll({ lastPollAt: '2026-01-01T11:59:50Z', lastStatus: 'ok', lastError: null, lastCount: 1 }, now).text).toBe('OK just now, 1 message processed')
  })
  test('error shows the message', () => {
    const d = describePoll({ lastPollAt: '2025-12-30T12:00:00Z', lastStatus: 'error', lastError: 'Invalid credentials', lastCount: null }, now)
    expect(d).toEqual({ tone: 'error', text: 'Failed 2 d ago: Invalid credentials' })
  })
})

describe('customer on behalf', () => {
  const alice = { id: 7, displayName: 'Alice', email: 'alice@x.io' }
  test('picked customer wins, typed address creates one', () => {
    expect(customerPayload(alice, 'ignored', '')).toEqual({ ok: true, body: { customerId: 7 } })
    expect(customerPayload(null, ' new@x.io ', ' Neo ')).toEqual({ ok: true, body: { customerEmail: 'new@x.io', customerName: 'Neo' } })
    expect(customerPayload(null, 'new@x.io', '')).toEqual({ ok: true, body: { customerEmail: 'new@x.io' } })
  })
  test('errors', () => {
    expect(customerPayload(null, '', '').ok).toBe(false)
    expect(customerPayload(null, 'not-mail', '')).toEqual({ ok: false, error: 'Enter a valid email address' })
  })
  test('isNewCustomerEmail', () => {
    expect(isNewCustomerEmail('new@x.io', [alice])).toBe(true)
    expect(isNewCustomerEmail('ALICE@x.io', [alice])).toBe(false)
    expect(isNewCustomerEmail('ali', [alice])).toBe(false)
    expect(looksLikeEmail('a@b')).toBe(false)
  })
})

describe('merge and link helpers', () => {
  const all = [
    { key: 'IT-1', summary: 'Printer broken' },
    { key: 'IT-2', summary: 'Laptop slow' },
    { key: 'IT-3', summary: 'Printer jam', resolved: '2026-01-01' },
    { key: 'IT-4', summary: 'Printer offline' },
  ]
  test('candidates exclude the source and closed requests and filter by text or key', () => {
    expect(mergeCandidates(all, 'IT-1', '').map((r) => r.key)).toEqual(['IT-2', 'IT-4'])
    expect(mergeCandidates(all, 'IT-1', 'printer').map((r) => r.key)).toEqual(['IT-4'])
    expect(mergeCandidates(all, 'IT-1', 'it-2').map((r) => r.key)).toEqual(['IT-2'])
    expect(mergeCandidates(all, 'IT-1', '', 1)).toHaveLength(1)
  })
  test('parseRequestKey', () => {
    expect(parseRequestKey(' it-12 ')).toBe('IT-12')
    expect(parseRequestKey('IT_X-1')).toBe('IT_X-1')
    expect(parseRequestKey('hello')).toBeNull()
    expect(parseRequestKey('IT-')).toBeNull()
  })
  test('describeMerge pluralises', () => {
    expect(describeMerge({ source: 'A-1', target: 'A-2', movedComments: 1, movedAttachments: 0, addedParticipants: 0 })).toBe('A-1 merged into A-2: 1 comment, 0 attachments moved')
    expect(describeMerge({ source: 'A-1', target: 'A-2', movedComments: 3, movedAttachments: 2, addedParticipants: 2 })).toBe('A-1 merged into A-2: 3 comments, 2 attachments, 2 participants moved')
  })
  test('linkOptions gives both readings except for symmetric types', () => {
    const opts = linkOptions([
      { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      { id: '2', name: 'Relates', inward: 'relates to', outward: 'relates to' },
    ])
    expect(opts.map((o) => o.value)).toEqual(['1:outward', '1:inward', '2:outward'])
    expect(opts[1]).toMatchObject({ label: 'is blocked by', linkTypeId: 1, direction: 'inward' })
  })
})
