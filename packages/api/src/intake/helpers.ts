/**
 * Pure helpers for Intake / triage. No I/O so everything is unit-testable.
 * All text is stored as plain text; email templates and the web UI escape on output.
 */
import { randomBytes } from 'crypto'
import { normalizeAddress } from '../servicedesk/inbound-email'

export const INTAKE_STATUSES = ['pending', 'accepted', 'declined', 'snoozed', 'duplicate'] as const
export type IntakeStatus = (typeof INTAKE_STATUSES)[number]
export const INTAKE_SOURCES = ['form', 'email', 'api', 'app'] as const
export type IntakeSource = (typeof INTAKE_SOURCES)[number]
export type IntakeAction = 'accept' | 'decline' | 'snooze' | 'duplicate' | 'reopen'

export const LIMITS = {
  title: 200,
  description: 10_000,
  name: 100,
  email: 254,
  reason: 2_000,
  formTitle: 120,
  formIntro: 2_000,
  /** Raw JSON body of the public form, in characters. */
  publicBody: 20_000,
  /** Raw JSON body of the email webhook, in characters. */
  emailBody: 300_000,
  /** Maximum snooze horizon. */
  snoozeDays: 366,
  bulk: 100,
} as const

export type FieldMode = 'off' | 'optional' | 'required'
export interface FieldConfig { name: FieldMode; email: FieldMode; description: FieldMode }
export const DEFAULT_FIELDS: FieldConfig = { name: 'optional', email: 'optional', description: 'optional' }
const MODES: readonly string[] = ['off', 'optional', 'required']

/** Defensive read of the stored jsonb: anything unexpected falls back to the default for that field. */
export function normalizeFields(raw: unknown): FieldConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pick = (k: keyof FieldConfig): FieldMode => (typeof r[k] === 'string' && MODES.includes(r[k] as string) ? (r[k] as FieldMode) : DEFAULT_FIELDS[k])
  return { name: pick('name'), email: pick('email'), description: pick('description') }
}

/** Unguessable URL slug: 144 bits of randomness, URL safe. */
export const generateSlug = (): string => randomBytes(18).toString('base64url')
export const isPlausibleSlug = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s)

/** Strip control characters (keep tab and newline), NULs included, and cap the length. */
export function cleanText(raw: unknown, max: number, multiline = true): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n')
  if (!multiline) s = s.replace(/\s+/g, ' ')
  return s.trim().slice(0, max)
}

export interface SubmissionInput { title?: unknown; description?: unknown; name?: unknown; email?: unknown }
export interface CleanSubmission { title: string; description: string; requesterName: string | null; requesterEmail: string | null }

/**
 * Validates and cleans a submission against the project's field configuration. Fields that are "off" are dropped
 * silently (never stored), so a client cannot smuggle data into a field the form does not collect.
 */
export function validateSubmission(input: SubmissionInput, fields: FieldConfig): { ok: true; value: CleanSubmission } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const title = cleanText(input.title, LIMITS.title, false)
  if (!title) errors.push('title is required')
  if (typeof input.title === 'string' && input.title.trim().length > LIMITS.title) errors.push(`title must be at most ${LIMITS.title} characters`)

  const description = fields.description === 'off' ? '' : cleanText(input.description, LIMITS.description)
  if (fields.description !== 'off' && typeof input.description === 'string' && input.description.length > LIMITS.description) errors.push(`description must be at most ${LIMITS.description} characters`)
  if (fields.description === 'required' && !description) errors.push('description is required')

  const name = fields.name === 'off' ? '' : cleanText(input.name, LIMITS.name, false)
  if (fields.name === 'required' && !name) errors.push('name is required')

  let email: string | null = null
  if (fields.email !== 'off') {
    const rawEmail = typeof input.email === 'string' ? input.email.trim() : ''
    if (rawEmail) {
      email = normalizeAddress(rawEmail)
      if (!email) errors.push('email is not a valid address')
    } else if (fields.email === 'required') {
      errors.push('email is required')
    }
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { title, description, requesterName: name || null, requesterEmail: email } }
}

/** Honeypot: a hidden field real visitors never fill. */
export const isHoneypotTripped = (v: unknown): boolean => typeof v === 'string' ? v.trim().length > 0 : v !== undefined && v !== null && v !== false

/** The state machine. Accepted items are final (an issue exists); everything else can be reopened. */
export function canApply(status: IntakeStatus, action: IntakeAction): boolean {
  switch (action) {
    case 'accept':
    case 'decline':
    case 'snooze':
    case 'duplicate':
      return status === 'pending' || status === 'snoozed'
    case 'reopen':
      return status === 'snoozed' || status === 'declined' || status === 'duplicate'
  }
}

/** Parses a snooze deadline: must be a valid date in the future and at most a year ahead. */
export function parseSnoozeUntil(raw: unknown, now: Date = new Date()): { ok: true; date: Date } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'until is required' }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'until is not a valid date' }
  if (d.getTime() <= now.getTime()) return { ok: false, error: 'until must be in the future' }
  if (d.getTime() > now.getTime() + LIMITS.snoozeDays * 86_400_000) return { ok: false, error: `until must be within ${LIMITS.snoozeDays} days` }
  return { ok: true, date: d }
}

/** True when a snoozed item is due to come back. */
export const isSnoozeDue = (status: string, snoozedUntil: Date | null, now: Date = new Date()): boolean =>
  status === 'snoozed' && !!snoozedUntil && snoozedUntil.getTime() <= now.getTime()

/** Description of the issue created from an item: the text plus a provenance line. */
export function issueDescription(item: { description: string; requesterName: string | null; requesterEmail: string | null; source: string }, extra?: string): string {
  const who = [item.requesterName, item.requesterEmail ? `<${item.requesterEmail}>` : null].filter(Boolean).join(' ')
  const parts = [item.description.trim()]
  if (extra?.trim()) parts.push(extra.trim())
  parts.push(`_Submitted via intake (${item.source})${who ? ` by ${who}` : ''}._`)
  return parts.filter(Boolean).join('\n\n')
}

/** A key, an id or a bare number as typed by a person -> normalised issue key / id lookup. */
export function parseIssueRef(raw: unknown): { key: string } | { id: number } | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw < 2_147_483_647) return { id: raw }
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (/^[A-Za-z][A-Za-z0-9_]{0,49}-\d{1,9}$/.test(t)) return { key: t.toUpperCase() }
  if (/^\d{1,9}$/.test(t) && Number(t) > 0) return { id: Number(t) }
  return null
}
