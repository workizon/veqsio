/** Pure validation helpers for custom branding (no database access, unit-tested). */

export const MAX_FILE_BYTES = 512 * 1024
export const MIN_CONTRAST_ON_WHITE = 3
export type BrandingSlot = 'light' | 'dark' | 'favicon'
export const SLOTS: readonly BrandingSlot[] = ['light', 'dark', 'favicon']
export const isSlot = (v: string): v is BrandingSlot => (SLOTS as readonly string[]).includes(v)

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Null when the accent colour is acceptable, otherwise the reason. */
export function checkAccentColor(v: unknown): string | null {
  if (!isHexColor(v)) return 'Accent colour must be a hex colour like #3D6AF0'
  const r = contrastRatio(v, '#ffffff')
  if (r < MIN_CONTRAST_ON_WHITE) return `Accent colour is too light: contrast on white is ${r.toFixed(2)}:1, at least ${MIN_CONTRAST_ON_WHITE}:1 is required`
  return null
}

/** Normalised http(s) URL of at most 500 characters; null when empty; undefined when invalid (javascript:, data: are refused). */
export function cleanUrl(v: unknown): string | null | undefined {
  if (v === null || v === '') return null
  if (typeof v !== 'string' || v.length > 500) return undefined
  try {
    const u = new URL(v.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined
  } catch { return undefined }
}

export type ImageKind = { mime: 'image/png' | 'image/svg+xml' | 'image/x-icon'; ext: string }

/** Detects the real type from the content (the client's Content-Type and file name are not trusted). */
export function sniffImage(bytes: Uint8Array, slot: BrandingSlot): { ok: true; kind: ImageKind } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: 'The file is empty' }
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: `The file is too large (maximum ${MAX_FILE_BYTES / 1024} KB)` }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.every((b, i) => bytes[i] === b)) return { ok: true, kind: { mime: 'image/png', ext: 'png' } }
  if (slot === 'favicon' && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return { ok: true, kind: { mime: 'image/x-icon', ext: 'ico' } }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)?(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)) {
    const bad = unsafeSvgReason(text)
    return bad ? { ok: false, error: bad } : { ok: true, kind: { mime: 'image/svg+xml', ext: 'svg' } }
  }
  return { ok: false, error: slot === 'favicon' ? 'Only PNG, SVG or ICO files are accepted' : 'Only PNG or SVG files are accepted' }
}

/**
 * SVGs are refused (not rewritten) when they contain anything active. As defence in depth they are also served with a
 * restrictive Content-Security-Policy and only ever rendered through <img>, where scripts never run.
 */
export function unsafeSvgReason(svg: string): string | null {
  if (/<script[\s>/]/i.test(svg)) return 'SVG files must not contain scripts'
  if (/<foreignObject[\s>/]/i.test(svg)) return 'SVG files must not contain foreignObject'
  if (/<(iframe|embed|object|audio|video|animate|set)\b/i.test(svg)) return 'SVG files must not contain embedded or animated active content'
  if (/\son[a-z]+\s*=/i.test(svg)) return 'SVG files must not contain event handlers'
  if (/javascript\s*:/i.test(svg)) return 'SVG files must not contain javascript: URLs'
  if (/<!ENTITY/i.test(svg)) return 'SVG files must not declare entities'
  if (/(?:href|src)\s*=\s*["']\s*(?!data:image\/|#)/i.test(svg)) return 'SVG files must not reference external resources'
  return null
}
