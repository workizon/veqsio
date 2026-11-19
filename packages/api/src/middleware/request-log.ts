import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../auth/middleware';
import { logger, requestContext, type RequestContext } from '../ops/logger';
import { httpDuration, httpInFlight, httpRequests, statusClass } from '../ops/metrics';
import { touchActiveUser } from '../ops/activity';
import { endRequestSpan, startRequestSpan } from '../observability/tracing';

const QUIET = new Set(['/health', '/ready', '/metrics']);
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Request id: a well-formed incoming X-Request-Id (set by the proxy) is kept so traces line up; anything else is replaced. */
export function resolveRequestId(incoming: string | undefined | null): string {
  return incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
}

/** Route pattern for labels and logs. Never the raw path: ids, slugs and tokens in URLs must not become label values. */
export function routePattern(c: { req: { routePath: string } }): string {
  const p = c.req.routePath;
  return !p || p === '/*' || p === '*' ? 'unmatched' : p;
}

/**
 * Outermost middleware. Assigns the request id (response header X-Request-Id, AsyncLocalStorage for every log line
 * written while the request runs), records the HTTP metrics and writes ONE access-log line when the request ends:
 * method, route pattern, status, duration_ms, request_id, user_id. No query string, no headers, no body, no IP.
 */
export function requestLog(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const requestId = resolveRequestId(c.req.header('x-request-id'));
    // OpenTelemetry (off unless configured): a server span that continues the caller's trace when a `traceparent` came in
    const rs = startRequestSpan({ traceparent: c.req.header('traceparent'), tracestate: c.req.header('tracestate') }, c.req.method);
    const ctx: RequestContext = { requestId, ...(rs ? { span: rs.span, traceId: rs.traceId, spanId: rs.spanId } : {}) };
    c.header('X-Request-Id', requestId);
    const started = performance.now();
    httpInFlight.inc();
    try {
      await requestContext.run(ctx, next);
    } finally {
      httpInFlight.dec();
      const seconds = (performance.now() - started) / 1000;
      const route = routePattern(c);
      const status = c.res?.status ?? 500;
      const labels = { method: c.req.method, route, status_class: statusClass(status) };
      httpRequests.inc(labels);
      httpDuration.observe(labels, seconds);
      endRequestSpan(rs, { method: c.req.method, route, status, requestId, dbQueries: ctx.dbQueries, errorName: c.error?.name });
      const user = c.get('user');
      if (user?.id) touchActiveUser(user.id);
      const quiet = QUIET.has(c.req.path);
      const level = status >= 500 ? 'error' : quiet ? 'debug' : 'info';
      requestContext.run(ctx, () => logger[level]('request', {
        method: c.req.method, route, status, duration_ms: Math.round(seconds * 1000), ...(user?.id ? { user_id: user.id } : {}),
      }));
    }
  };
}

/** Mounted after the session middleware: lets log lines written inside handlers carry the user id. */
export function requestUserContext(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const ctx = requestContext.getStore();
    const user = c.get('user');
    if (ctx && user?.id) ctx.userId = user.id;
    await next();
  };
}
