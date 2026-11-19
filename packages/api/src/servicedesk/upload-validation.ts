/** Upload validation helpers for customer-supplied files. Pure functions, unit tested. */

export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_REQUEST = 20

export const maxAttachmentBytes = () => {
  const n = Number(process.env.PORTAL_MAX_ATTACHMENT_BYTES)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ATTACHMENT_BYTES
}

/** Strip path components, control characters and separators; cap at 255 chars keeping the extension. */
export function sanitizeFileName(name: string): string {
  let n = String(name ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/["<>:*?|]/g, '_')
    .trim()
  n = n.replace(/^\.+/, '').replace(/\.+$/, '').trim()
  if (!n || n === '.' || n === '..') n = 'file'
  if (n.length > 255) {
    const dot = n.lastIndexOf('.')
    const ext = dot > 0 && n.length - dot <= 20 ? n.slice(dot) : ''
    n = n.slice(0, 255 - ext.length) + ext
  }
  return n
}

/** Safe storage extension derived from a sanitized name. */
export function safeExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'bin'
}

export type SniffResult = { kind: 'known'; mime: string } | { kind: 'executable' } | { kind: 'unknown' }

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v)

/** Detect a few common formats from magic bytes and flag executables. */
export function sniffContent(b: Uint8Array): SniffResult {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'known', mime: 'image/png' }
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: 'known', mime: 'image/jpeg' }
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return { kind: 'known', mime: 'image/gif' }
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'known', mime: 'application/pdf' }
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) return { kind: 'known', mime: 'application/zip' }
  // Windows PE/DOS (MZ), ELF, Mach-O (thin and fat, both endiannesses), Java class / fat Mach-O (CAFEBABE), shebang scripts
  if (startsWith(b, [0x4d, 0x5a])) return { kind: 'executable' }
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return { kind: 'executable' }
  if (startsWith(b, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(b, [0xfe, 0xed, 0xfa, 0xcf]) ||
      startsWith(b, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) ||
      startsWith(b, [0xca, 0xfe, 0xba, 0xbe])) return { kind: 'executable' }
  if (startsWith(b, [0x23, 0x21])) return { kind: 'executable' }
  return { kind: 'unknown' }
}

const BINARY_FORMATS = new Set(['image/png', 'image/jpeg', 'image/gif', 'application/pdf', 'application/zip'])
/** Types that can carry active content in a browser; never accepted from customers. */
const ACTIVE_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/javascript'])

export function normalizeMime(declared: string): string {
  return String(declared ?? '').split(';')[0].trim().toLowerCase()
}

export type ContentCheck = { ok: true; mime: string } | { ok: false; error: string }

/**
 * Verify the declared MIME type against the first bytes. Returns the MIME type to store:
 * the sniffed type when recognised, otherwise the declared one.
 */
export function checkContent(declaredRaw: string, head: Uint8Array): ContentCheck {
  const declared = normalizeMime(declaredRaw) || 'application/octet-stream'
  if (ACTIVE_TYPES.has(declared)) return { ok: false, error: 'File type not allowed' }
  const sniff = sniffContent(head)
  if (sniff.kind === 'executable') return { ok: false, error: 'File type not allowed' }
  if (sniff.kind === 'known') {
    if (declared !== sniff.mime && declared !== 'application/octet-stream') return { ok: false, error: 'File content does not match its type' }
    return { ok: true, mime: sniff.mime }
  }
  // Unrecognised bytes: must not claim to be a binary format we can verify.
  if (BINARY_FORMATS.has(declared) || declared.startsWith('image/')) return { ok: false, error: 'File content does not match its type' }
  // Text-like types must be text (no NUL bytes) and must not look like markup.
  if (declared.startsWith('text/') || declared === 'application/json') {
    if (head.includes(0)) return { ok: false, error: 'File content does not match its type' }
    const text = new TextDecoder().decode(head.subarray(0, 512)).trimStart().toLowerCase()
    if (text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<script') || text.startsWith('<svg') || text.startsWith('<?xml')) {
      return { ok: false, error: 'File type not allowed' }
    }
  }
  return { ok: true, mime: declared }
}
