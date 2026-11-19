/**
 * Pure helpers for plugin UI panels (see docs/plugins.md, "UI panel contract").
 *
 * The iframe is sandboxed WITHOUT allow-same-origin, so its origin is opaque and `MessageEvent.origin` is the string
 * "null". The sender is therefore authenticated by identity (`event.source === iframe.contentWindow`) and by the
 * opaque origin; the declared panel origin cannot be checked on messages.
 */

export const PANEL_SANDBOX = 'allow-scripts allow-forms'
export const MIN_HEIGHT = 40
export const MAX_HEIGHT = 2000

export interface PanelContext { issue?: string; project?: string }

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Iframe src: panel URL + only `issue` and `project` query parameters. No tokens, no cookies, nothing else. */
export function buildPanelSrc(panelUrl: string, ctx: PanelContext): string | null {
  let u: URL
  try { u = new URL(panelUrl) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  u.search = ''
  u.hash = ''
  if (ctx.issue && KEY_RE.test(ctx.issue)) u.searchParams.set('issue', ctx.issue)
  if (ctx.project && KEY_RE.test(ctx.project)) u.searchParams.set('project', ctx.project)
  return u.toString()
}

export type PanelMessage = { type: 'resize'; height: number } | { type: 'navigate'; path: string }

/** Same-origin path only: starts with a single "/", no scheme, no backslash, no control characters. */
export function isSafeNavigatePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length <= 2048 &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !/[\\\u0000-\u001f]/.test(path) &&
    !/^\/+[a-z][a-z0-9+.-]*:/i.test(path)
  )
}

/** Validate a message from a panel. Returns null for anything that is not part of the documented protocol. */
export function parsePanelMessage(origin: string, data: unknown): PanelMessage | null {
  if (origin !== 'null') return null // sandboxed iframe without allow-same-origin
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.source !== 'veqsio-plugin') return null
  if (d.type === 'resize') {
    const h = Number(d.height)
    if (!Number.isFinite(h)) return null
    return { type: 'resize', height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(h))) }
  }
  if (d.type === 'navigate') {
    return isSafeNavigatePath(d.path) ? { type: 'navigate', path: d.path } : null
  }
  return null
}
