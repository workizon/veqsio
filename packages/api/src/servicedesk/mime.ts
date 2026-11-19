/**
 * MIME parsing for the IMAP poller: raw RFC 822 source -> a small normalized message.
 * Uses `mailparser` for the heavy lifting (encodings, multipart, charsets). The html-to-text fallback is ours
 * and turns blockquotes into `>` lines so quote stripping works for HTML-only mail too.
 */
import { createHash } from 'crypto'
import { simpleParser, type ParsedMail } from 'mailparser'
import { parseMessageIds } from './mail-threading'

export interface InboundAttachment { filename: string; contentType: string; content: Uint8Array }

export interface NormalizedMail {
  messageId: string
  /** Raw From value, e.g. `Jane <jane@x.io>` */
  from: string
  subject: string
  text: string
  /** Lowercased header names -> flattened string values (only the ones the loop detector needs plus threading) */
  headers: Record<string, string>
  inReplyTo: string[]
  references: string[]
  attachments: InboundAttachment[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Very small, dependency free HTML to text conversion (never used to produce HTML). */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  // Quoted replies: prefix every line inside a blockquote with "> "
  let guard = 0
  while (/<blockquote[^>]*>/i.test(s) && guard++ < 20) {
    s = s.replace(/<blockquote[^>]*>((?:(?!<blockquote)[\s\S])*?)<\/blockquote>/gi, (_m, inner: string) =>
      '\n' + htmlToText(inner).split('\n').map((l) => `> ${l}`).join('\n') + '\n')
  }
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function flattenHeader(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(flattenHeader).join(', ')
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    const o = v as { value?: unknown; params?: Record<string, string>; text?: string }
    if (typeof o.text === 'string') return o.text
    const base = flattenHeader(o.value)
    const params = o.params ? Object.entries(o.params).map(([k, val]) => `${k}=${val}`).join('; ') : ''
    return params ? `${base}; ${params}` : base
  }
  return String(v)
}

const KEPT_HEADERS = [
  'auto-submitted', 'precedence', 'x-autoreply', 'x-autorespond', 'x-auto-response-suppress', 'return-path',
  'content-type', 'list-id', 'list-unsubscribe', 'in-reply-to', 'references', 'x-failed-recipients',
]

export function normalizeParsed(p: ParsedMail, raw?: Uint8Array): NormalizedMail {
  const headers: Record<string, string> = {}
  for (const k of KEPT_HEADERS) {
    if (p.headers.has(k)) headers[k] = flattenHeader(p.headers.get(k)).slice(0, 2000)
  }
  const text = (typeof p.text === 'string' && p.text.trim() ? p.text : typeof p.html === 'string' ? htmlToText(p.html) : '')
  const from = p.from?.value?.[0]
    ? (p.from.value[0].name ? `${p.from.value[0].name} <${p.from.value[0].address ?? ''}>` : p.from.value[0].address ?? '')
    : ''
  const fallbackId = `<${createHash('sha256').update(raw ?? `${from}${p.subject ?? ''}${text}`).digest('hex').slice(0, 32)}@no-message-id.veqsio>`
  return {
    messageId: (p.messageId && p.messageId.trim()) || fallbackId,
    from,
    subject: p.subject ?? '',
    text,
    headers,
    inReplyTo: parseMessageIds(p.inReplyTo),
    references: parseMessageIds(p.references),
    attachments: (p.attachments ?? [])
      // inline images referenced by the html body (signatures, logos) are not customer attachments
      .filter((a) => !(a.contentDisposition === 'inline' && a.related))
      .map((a) => ({ filename: a.filename || 'attachment', contentType: a.contentType || 'application/octet-stream', content: a.content })),
  }
}

/** Parse a raw RFC 822 message. Throws only for unreadable input; callers treat that as a rejected message. */
export async function parseRawMessage(raw: Buffer | Uint8Array | string): Promise<NormalizedMail> {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw)
  const parsed = await simpleParser(buf, { skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: true })
  return normalizeParsed(parsed, buf)
}
