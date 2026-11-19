/**
 * Request-level guards applied to the whole API (mounted in app.ts):
 *  - numericIdGuard:  `/board/abc` is a 404, not a database error
 *  - bodyGuard:       size limit (413) and malformed JSON (400) before any handler runs
 *  - csrfGuard:       cookie-authenticated state-changing requests must come from our own origin
 */
import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/* ------------------------------------------------------------------ */
/*  Numeric path parameters                                             */
/* ------------------------------------------------------------------ */

const ID_PARAM = /^(?:id|[a-z]+Id|qid|aid|cid)$/;
const MAX_INT = 2147483647;

/**
 * Path parameters that are database ids (`:id`, `:boardId`, `:commentId`, ...) must be positive integers that fit
 * a 32 bit column. Anything else cannot exist, so it is answered with 404 instead of being handed to the database
 * (where `Number('abc')` = NaN would surface as a 500). SCIM ids are opaque strings and are exempt.
 */
export function numericIdGuard() {
  return createMiddleware(async (c, next) => {
    const routes = c.req.matchedRoutes;
    const handler = routes.find((r) => r.method !== "ALL"); // first match = the handler that actually runs
    const pattern = handler?.path;
    if (!pattern || !pattern.includes(':') || pattern.startsWith('/scim/')) return next();
    const want = pattern.split('/');
    const got = c.req.path.split('/');
    for (let i = 0; i < want.length; i++) {
      if (!want[i].startsWith(':')) continue;
      const name = want[i].slice(1).replace(/\{.*$/, '');
      if (!ID_PARAM.test(name)) continue;
      const value = got[i] ?? '';
      if (!/^\d{1,10}$/.test(value) || Number(value) > MAX_INT) {
        return c.json({ errorMessages: ['Resource not found'] }, 404);
      }
    }
    return next();
  });
}

/* ------------------------------------------------------------------ */
/*  Body size and JSON validity                                         */
/* ------------------------------------------------------------------ */

/** Default cap for JSON request bodies: 2 MiB (override with JSON_BODY_LIMIT_BYTES). Multipart uploads are not JSON and keep their own limits. */
const jsonLimit = () => {
  const n = Number(process.env.JSON_BODY_LIMIT_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 2 * 1024 * 1024;
};

/**
 * JSON bodies: refuse anything above the limit with 413 *before* it is buffered whole (declared length first, then
 * a capped streaming read for chunked bodies), and turn malformed JSON into a clean 400. The parsed body is cached
 * by Hono, so handlers calling c.req.json() do not parse twice.
 */
export function bodyGuard() {
  return createMiddleware(async (c: Context, next: Next) => {
    // A NUL byte cannot be stored in PostgreSQL text and would surface as a database error (500).
    if (/%00/i.test(c.req.url)) return c.json({ errorMessages: ['Invalid character in request'] }, 400);
    if (!BODY_METHODS.has(c.req.method)) return next();
    const ct = (c.req.header('content-type') || '').toLowerCase();
    if (!ct.includes('json')) return next();
    const limit = jsonLimit();

    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > limit) return c.json({ errorMessages: ['Request body too large'] }, 413);
    // SCIM answers malformed bodies in its own error format (RFC 7644); its handlers parse the body themselves.
    if (c.req.path.startsWith('/scim/')) return next();

    const body = c.req.raw.body;
    if (!body) return next();

    // Read at most limit+1 bytes. For a declared (trusted) length this is a plain read; for chunked bodies it stops early.
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return c.json({ errorMessages: ['Request body too large'] }, 413);
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(size);
    let off = 0;
    for (const ch of chunks) {
      buf.set(ch, off);
      off += ch.length;
    }
    // Hand the (already read) body on to the handlers.
    c.req.raw = new Request(c.req.raw, { body: size ? buf : undefined });

    if (size > 0) {
      if (/\\u0000/i.test(new TextDecoder().decode(buf))) {
        return c.json({ errorMessages: ['Invalid character in request body'] }, 400);
      }
      try {
        await c.req.json();
      } catch {
        return c.json({ errorMessages: ['Invalid JSON body'] }, 400);
      }
    }
    return next();
  });
}

/* ------------------------------------------------------------------ */
/*  CSRF                                                                */
/* ------------------------------------------------------------------ */

function allowedOrigins(): Set<string> {
  const set = new Set<string>();
  const add = (u?: string) => {
    if (!u) return;
    try {
      set.add(new URL(u).origin);
    } catch {
      /* ignore bad config */
    }
  };
  add(process.env.WEB_URL || 'http://localhost:3001');
  for (const u of (process.env.CORS_ORIGINS || '').split(',')) add(u.trim());
  return set;
}

/** Endpoints that accept file uploads (multipart/form-data). */
const UPLOAD_PATH = /\/attachments?(\/|$)|\/migration\/|\/csv-import\/|\/avatar$|\/backup$|\/admin\/branding\/logo\/[a-z]+$/;

const SAML_ACS = /^\/rest\/auth\/1\/saml\/[a-z0-9-]+\/acs$/;

function hasSessionCookie(c: Context): boolean {
  return /(?:^|;\s*)session=/.test(c.req.header('cookie') || '');
}

/**
 * Cookies are ambient credentials, so a state-changing request that carries only the session cookie must prove
 * it comes from our own web app. SameSite=Lax already blocks the classic cross-site form post in current browsers;
 * this is defence in depth for older browsers, sibling subdomains and misconfigured proxies:
 *   - `Sec-Fetch-Site: cross-site` (or same-site from another origin) is refused,
 *   - an `Origin` header must be our web origin or equal to the Host the request was sent to,
 *   - bodies must be JSON or multipart (so `text/plain` / urlencoded "simple requests" never work).
 * Requests without cookie (bearer tokens, SCIM, inbound email, login) and requests without Origin/Sec-Fetch-Site
 * (curl, server-to-server) are unaffected.
 */
export function csrfGuard() {
  return createMiddleware(async (c: Context, next: Next) => {
    // SAML ACS: the IdP's browser POST is cross-site by design (form post from the IdP origin, possibly with an
    // existing session cookie). It carries no ambient authority: the signed assertion, the single-use RelayState
    // and the InResponseTo binding authenticate it (see auth/saml-service.ts).
    if (SAML_ACS.test(c.req.path)) return next();
    if (!BODY_METHODS.has(c.req.method) || !hasSessionCookie(c)) return next();
    if ((c.req.header('authorization') || '').startsWith('Bearer ')) return next(); // token auth wins, cookie is ignored

    const fetchSite = c.req.header('sec-fetch-site');
    const origin = c.req.header('origin');
    const host = c.req.header('x-forwarded-host') || c.req.header('host');

    if (fetchSite === 'cross-site') return c.json({ errorMessages: ['Cross-site request refused'] }, 403);

    if (origin !== undefined) {
      let ok = false;
      if (origin !== 'null') {
        try {
          const o = new URL(origin);
          ok = allowedOrigins().has(o.origin) || (!!host && o.host === host);
        } catch {
          ok = false;
        }
      }
      if (!ok) return c.json({ errorMessages: ['Cross-origin request refused'] }, 403);
    } else if (fetchSite === 'same-site') {
      return c.json({ errorMessages: ['Cross-origin request refused'] }, 403);
    }

    const ct = (c.req.header('content-type') || '').toLowerCase();
    const hasBody = c.req.raw.body !== null && c.req.header('content-length') !== '0';
    // multipart is only legitimate where files are uploaded
    const multipartOk = ct.startsWith('multipart/form-data') && UPLOAD_PATH.test(c.req.path);
    if (hasBody && ct !== '' && !ct.includes('json') && !multipartOk) {
      return c.json({ errorMessages: ['Unsupported content type'] }, 415);
    }
    return next();
  });
}
