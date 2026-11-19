import { createMiddleware } from 'hono/factory';

/**
 * Database driver errors carry the full SQL text and bound parameters ("Failed query: select ... params: ...").
 * Several routes echo `err.message` to the client, which leaks schema details and any value an attacker
 * managed to push into a query. This middleware rewrites such error bodies to a generic message (the original
 * is logged server-side). Only error responses with a JSON body are inspected, so the happy path is untouched.
 */
const LEAK = /Failed query:|\bparams:|syntax error at or near|violates (?:foreign key|unique|not-null)|invalid input syntax|relation "[a-z_]+" does not exist|column "[a-z_]+" does not exist/i;

export function sanitizeDbErrors() {
  return createMiddleware(async (c, next) => {
    await next();
    const res = c.res;
    if (res.status < 400 || !(res.headers.get('content-type') || '').includes('application/json')) return;
    let text: string;
    try {
      text = await res.clone().text();
    } catch {
      return;
    }
    if (!LEAK.test(text)) return;
    console.error('[sanitized error response]', res.status, text.slice(0, 500));
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    c.res = new Response(JSON.stringify({ errorMessages: ['Internal server error'] }), {
      status: res.status >= 500 ? res.status : 400,
      headers,
    });
  });
}
