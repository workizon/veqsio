import { createMiddleware } from 'hono/factory'

/**
 * Baseline security headers for every API response. HSTS and CSP are intentionally
 * not set here: TLS termination and the page CSP belong to the reverse proxy (nginx).
 * Headers a route already set (e.g. attachment downloads) are left untouched.
 */
export const securityHeaders = () =>
  createMiddleware(async (c, next) => {
    await next()
    const set = (name: string, value: string) => {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value)
    }
    set('X-Content-Type-Options', 'nosniff')
    set('Referrer-Policy', 'strict-origin-when-cross-origin')
    set('X-Frame-Options', 'DENY')
  })
