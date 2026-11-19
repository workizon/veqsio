import { createMiddleware } from 'hono/factory'

/**
 * The router decodes a percent-encoded path before it picks a route (`/admin` and `/%61dmin` reach the same handler), while code that
 * looks at the raw URL sees different text. Every guard that decides by path (token scopes, demo and cloud mode, maintenance mode)
 * therefore reads the decoded path the router uses, and this guard refuses the one thing that has no honest use: a path in which a
 * letter, digit or one of `-._~` is written as %XX. Browsers and HTTP libraries never do that; an attacker does, to get past a filter.
 */
const ENCODED_UNRESERVED = /%(?:3[0-9]|4[1-9a-f]|5[0-9af]|6[1-9a-f]|7[0-9ae]|2[de])/i

export function hasEncodedUnreserved(rawPath: string): boolean { return ENCODED_UNRESERVED.test(rawPath) }

export function pathGuard() {
  return createMiddleware(async (c, next) => {
    const raw = new URL(c.req.url).pathname
    if (hasEncodedUnreserved(raw)) return c.json({ errorMessages: ['Invalid request path'] }, 400)
    return next()
  })
}
