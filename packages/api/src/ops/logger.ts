/**
 * Structured logging.
 *
 *  - One JSON object per line on stdout/stderr: {ts, level, msg, request_id?, user_id?, ...fields}.
 *  - LOG_LEVEL=debug|info|warn|error|silent (default info; warn under NODE_ENV=test), LOG_FORMAT=json|text (default json).
 *  - Secrets and personal data never reach the log: values of keys that look like credentials are replaced, and e-mail
 *    addresses, bearer tokens and long hex/base64 token-looking strings inside messages are masked.
 *  - The per-request context (request id, user id) travels in an AsyncLocalStorage, so ANY log line written while a
 *    request is handled, including the existing `console.error('[email] ...')` calls once `installConsoleJson()` ran,
 *    carries the request id.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface RequestContext {
  requestId: string; userId?: number | null;
  /** Tracing: the request's span (when OpenTelemetry is on), its ids for log correlation, and the database queries counted so far. */
  span?: import('@opentelemetry/api').Span; traceId?: string; spanId?: string; dbQueries?: number;
}
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * A level an administrator set at runtime (Administration → Logs), for finding a problem without a restart. It overrides LOG_LEVEL
 * on this node and ends by itself after `expiresAt` (verbose logging left on by accident fills the disk and the noise hides real
 * problems), or when the process restarts.
 */
let runtimeLevel: { level: Level | 'silent'; expiresAt: number } | null = null
export function setRuntimeLevel(level: Level | 'silent' | null, minutes = 60, now = Date.now()): { level: Level | 'silent'; expiresAt: number } | null {
  runtimeLevel = level === null ? null : { level, expiresAt: now + Math.max(1, Math.min(minutes, 24 * 60)) * 60_000 }
  return runtimeLevel
}
export function runtimeLevelState(now = Date.now()): { level: Level | 'silent'; expiresAt: number } | null {
  if (runtimeLevel && runtimeLevel.expiresAt <= now) runtimeLevel = null
  return runtimeLevel
}

export function currentLevel(env: Record<string, string | undefined> = process.env): Level | 'silent' {
  const rt = runtimeLevelState()
  if (rt) return rt.level
  const v = (env.LOG_LEVEL || '').toLowerCase();
  if (v in RANK) return v as Level | 'silent';
  return env.NODE_ENV === 'test' ? 'warn' : 'info';
}
export function logFormat(env: Record<string, string | undefined> = process.env): 'json' | 'text' {
  return (env.LOG_FORMAT || '').toLowerCase() === 'text' ? 'text' : 'json';
}

const SECRET_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|signature|credential|private|session|e-?mail|bearer|dsn|connection/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDS = /(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g;
const QUERY_SECRET = /([?&](?:token|key|secret|password|code|ticket|signature|sig|access_token)=)[^&\s"']+/gi;
const LONG_TOKEN = /\b(?:veq[a-z]*_|pat_|sk-|ghp_|xox[a-z]-)[A-Za-z0-9_-]{8,}\b|\b[0-9a-f]{40,}\b/gi;

/** Masks credentials and personal data inside a free-text string. */
export function scrubString(s: string): string {
  return s
    .replace(URL_CREDS, '$1[redacted]@')
    .replace(BEARER, '$1 [redacted]')
    .replace(QUERY_SECRET, '$1[redacted]')
    .replace(EMAIL, '[email]')
    .replace(LONG_TOKEN, '[redacted]');
}

/** Deep copy with secret-looking keys replaced and strings scrubbed; bounded depth and size. */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubString(value.length > 2000 ? value.slice(0, 2000) + '…' : value);
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message), stack: scrubString((value.stack || '').split('\n').slice(0, 6).join('\n')) };
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** The last log records of this node, already scrubbed, for the log viewer. Memory only: restarts and other nodes are not included. */
export interface LogRecord { ts: string; level: Level; msg: string; [k: string]: unknown }
const RING_SIZE = 2000
const ring: LogRecord[] = []
function remember(rec: Record<string, unknown>): void {
  ring.push(rec as LogRecord)
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)
}
export function recentLogs(opts: { level?: Level; q?: string; limit?: number; before?: string } = {}): LogRecord[] {
  const min = opts.level ? RANK[opts.level] : 0
  const q = opts.q?.toLowerCase()
  const out: LogRecord[] = []
  for (let i = ring.length - 1; i >= 0 && out.length < Math.min(opts.limit ?? 200, 1000); i--) {
    const r = ring[i]
    if (RANK[r.level] < min) continue
    if (opts.before && r.ts >= opts.before) continue
    if (q && !(r.msg.toLowerCase().includes(q) || JSON.stringify(r).toLowerCase().includes(q))) continue
    out.push(r)
  }
  return out
}
export function clearRecentLogsForTests(): void { ring.length = 0 }

type Sink = (line: string, level: Level) => void;
const realConsole = { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console), info: console.info.bind(console), debug: console.debug.bind(console) };
let sink: Sink = (line, level) => (level === 'error' || level === 'warn' ? realConsole.error(line) : realConsole.log(line));
/** Tests capture output through this; returns a restore function. */
export function setLogSink(s: Sink): () => void { const prev = sink; sink = s; return () => { sink = prev; }; }

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (RANK[level] < RANK[currentLevel()]) return;
  const ctx = requestContext.getStore();
  const safeFields = redact(fields) as Record<string, unknown>;
  const rec: Record<string, unknown> = { ts: new Date().toISOString(), level, msg: scrubString(String(msg)) };
  if (ctx) { rec.request_id = ctx.requestId; if (ctx.userId != null) rec.user_id = ctx.userId; if (ctx.traceId) { rec.trace_id = ctx.traceId; rec.span_id = ctx.spanId; } }
  Object.assign(rec, safeFields);
  remember(rec);
  if (logFormat() === 'text') {
    const extra = Object.entries(safeFields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
    sink(`${rec.ts} ${level.toUpperCase()} ${rec.msg}${ctx ? ` request_id=${ctx.requestId}` : ''}${extra ? ' ' + extra : ''}`, level);
  } else {
    sink(JSON.stringify(rec), level);
  }
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => log('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => log('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => log('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => log('error', msg, f),
};

/**
 * Routes the plain `console.*` calls scattered through the code base (`console.log('[email] ...')`) through the
 * structured logger, so every line is JSON, scrubbed, level-filtered and carries the request id. Called once from
 * index.ts; importing the app (tests) leaves the console untouched.
 */
export function installConsoleJson(): void {
  const fmt = (args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : (() => { try { return JSON.stringify(redact(a)); } catch { return String(a); } })())).join(' ');
  const errField = (args: unknown[]) => { const e = args.find((a) => a instanceof Error) as Error | undefined; return e ? { error: e } : {}; };
  console.log = (...a: unknown[]) => log('info', fmt(a));
  console.info = (...a: unknown[]) => log('info', fmt(a));
  console.debug = (...a: unknown[]) => log('debug', fmt(a));
  console.warn = (...a: unknown[]) => log('warn', fmt(a), errField(a));
  console.error = (...a: unknown[]) => log('error', fmt(a), errField(a));
}
