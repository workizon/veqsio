/**
 * Pure helpers for the service desk inbound email channel.
 * No I/O here so everything is unit-testable. Output is stored as plain text;
 * templates/UI escape on render.
 */

export const MAX_BODY_CHARS = 20_000
export const MAX_SUBJECT_CHARS = 500

/** Strip control chars, collapse whitespace to one line, cap length. */
export function sanitizeSubject(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const oneLine = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return oneLine.slice(0, MAX_SUBJECT_CHARS)
}

/** Subject without reply/forward prefixes and the issue key tag, for use as a request summary. */
export function summaryFromSubject(subject: string, projectKey?: string): string {
  let s = sanitizeSubject(subject)
  let prev = ''
  while (prev !== s) {
    prev = s
    s = s.replace(/^\s*(re|fw|fwd|aw|wg|sv|antw)\s*:\s*/i, '')
  }
  if (projectKey) s = s.replace(new RegExp(`\\[${escapeRegex(projectKey)}-\\d+\\]`, 'ig'), '')
  s = s.replace(/\s+/g, ' ').trim()
  return (s || '(no subject)').slice(0, 255)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Find an issue key of the desk's project in the subject, e.g. "Re: [ABC-123] Printer broken". */
export function extractIssueKey(subject: string, projectKey: string): string | null {
  if (!projectKey) return null
  const k = escapeRegex(projectKey)
  const bracketed = new RegExp(`\\[(${k}-\\d{1,9})\\]`, 'i').exec(subject)
  if (bracketed) return bracketed[1].toUpperCase()
  const bare = new RegExp(`(?<![A-Za-z0-9_-])(${k}-\\d{1,9})(?![A-Za-z0-9_-])`, 'i').exec(subject)
  return bare ? bare[1].toUpperCase() : null
}

/** Lowercased bare address from "Name <a@b.c>" or "a@b.c"; null when it is not a plausible address. */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 998) return null
  const angle = /<([^<>]+)>\s*$/.exec(raw)
  const candidate = (angle ? angle[1] : raw).trim().toLowerCase()
  if (candidate.length > 254) return null
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(candidate)) return null
  if (candidate.includes('..')) return null
  return candidate
}

export const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1)

/** Empty allow-list means any domain. Entries may be "example.com" or "@example.com". */
export function isDomainAllowed(address: string, allowed: unknown): boolean {
  if (!Array.isArray(allowed) || allowed.length === 0) return true
  const d = domainOf(address)
  return allowed.some((a) => typeof a === 'string' && a.trim().toLowerCase().replace(/^@/, '') === d)
}

export function normalizeDomains(list: string[]): string[] {
  const out = new Set<string>()
  for (const raw of list) {
    const d = raw.trim().toLowerCase().replace(/^@/, '')
    if (d) out.add(d)
  }
  return [...out]
}

const WROTE_LINE = /^\s*(on|am|le|el)\s.+/i
const WROTE_END = /(wrote|schrieb|a écrit|escribió)\b[^\n]{0,200}:$/i
const ORIGINAL_MARKER = /^\s*-{2,}\s*(original message|forwarded message|ursprüngliche nachricht)\s*-{2,}\s*$/i
const SENT_FROM = /^\s*(sent from my|get outlook for|sent from outlook|sent from mail for)\b/i

/** Remove quoted replies and signatures from a plain text email body. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '-- ' || line === '--' || /^-- ?$/.test(line)) break // signature delimiter
    if (ORIGINAL_MARKER.test(line)) break
    if (SENT_FROM.test(line)) break
    // "On Mon, 3 Jun 2024, Jane <j@x> wrote:" possibly wrapped over up to 3 lines
    if (WROTE_LINE.test(line)) {
      // quote header if this or one of the next two lines ends with "wrote:"
      if ([0, 1, 2].some((n) => WROTE_END.test((lines[i + n] ?? '').trim()))) break
    }
    // Outlook style header block: "From: ..." followed by "Sent:/Date: ..." within a few lines
    if (/^\s*(from|von|de)\s*:\s*\S/i.test(line) && [1, 2, 3, 4].some((n) => /^\s*(sent|gesendet|date|datum|envoy[eé])\s*:/i.test(lines[i + n] ?? ''))) break
    if (/^\s*_{10,}\s*$/.test(line) && /^\s*(from|von|de)\s*:/i.test(lines[i + 1] ?? '')) break
    if (/^\s*>/.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** Plain text body: quotes/signature stripped, NULs removed, capped. */
export function cleanBody(text: unknown): string {
  if (typeof text !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const noCtl = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return stripQuotedReply(noCtl.slice(0, MAX_BODY_CHARS * 3)).slice(0, MAX_BODY_CHARS)
}

export type AutoReplyReason = 'auto-submitted' | 'precedence' | 'x-autoreply' | 'subject'
export type LoopReason = AutoReplyReason | 'bounce' | 'mailing-list' | 'self' | 'own-message'

/** Detect auto-replies / bulk mail to avoid mail loops. Header names are case-insensitive. */
export function detectAutoReply(
  headers: Record<string, string | undefined> | undefined,
  subject: string,
): AutoReplyReason | null {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) if (typeof v === 'string') h[k.toLowerCase()] = v.trim().toLowerCase()
  if (h['auto-submitted'] !== undefined && h['auto-submitted'] !== 'no') return 'auto-submitted'
  if (h['precedence'] !== undefined && /^(bulk|junk|list|auto_reply)$/.test(h['precedence'])) return 'precedence'
  if (h['x-autoreply'] !== undefined || h['x-autorespond'] !== undefined || h['x-auto-response-suppress'] !== undefined) return 'x-autoreply'
  if (/^\s*(out of office|automatic reply|auto(matic)?[- ]?reply|autoreply|undeliverable|delivery status notification)/i.test(subject)) return 'subject'
  return null
}

const BOUNCE_SENDER = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i
const BOUNCE_SUBJECT = /^\s*(undeliverable|delivery (status|failure|has failed)|mail delivery (failed|system|failure)|returned mail|failure notice|undelivered mail)/i

/**
 * Everything the mail loop guard rejects: auto-replies, bounces / delivery reports, mailing list traffic, mail from
 * the desk's own addresses and our own outbound Message-IDs copied back into the mailbox. Pure; the caller supplies
 * the desk's own addresses (reply address, IMAP user, SMTP sender).
 */
export function detectLoop(o: {
  headers?: Record<string, string | undefined>
  subject: string
  from: string | null
  messageId?: string
  ownAddresses?: Array<string | null | undefined>
}): LoopReason | null {
  const auto = detectAutoReply(o.headers, o.subject)
  if (auto) return auto
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(o.headers ?? {})) if (typeof v === 'string') h[k.toLowerCase()] = v.trim().toLowerCase()
  const ct = h['content-type'] ?? ''
  if (/^multipart\/report/.test(ct) && /report-type="?(delivery-status|disposition-notification)/.test(ct)) return 'bounce'
  if (h['return-path'] === '<>' || h['x-failed-recipients'] !== undefined) return 'bounce'
  if (o.from && BOUNCE_SENDER.test(o.from)) return 'bounce'
  if (BOUNCE_SUBJECT.test(o.subject)) return 'bounce'
  if (h['list-id'] !== undefined || h['list-unsubscribe'] !== undefined) return 'mailing-list'
  if (o.from) {
    const own = (o.ownAddresses ?? []).map((a) => (a ? normalizeAddress(a) : null)).filter(Boolean)
    if (own.includes(o.from.toLowerCase())) return 'self'
  }
  if (o.messageId && /^<req\.[A-Za-z0-9]+-\d{1,9}\.[A-Za-z0-9]+@/.test(o.messageId)) return 'own-message'
  return null
}
