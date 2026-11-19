/**
 * Enforces personal access token scopes. Cookie sessions are not affected.
 *
 * Scopes: `*` and `admin` (everything), `read:*`, `write:*`, `read:issues`, `write:issues`,
 * `read:projects`, `write:projects`. `write:X` implies `read:X`.
 * Deny by default: a scoped token may only reach the resource families its scopes name.
 */
import { createMiddleware } from 'hono/factory';
import type { AppContext } from '../auth/middleware';
import { runTokenAllows } from '../agents/auth';

export const VALID_SCOPES = ['*', 'admin', 'read:*', 'write:*', 'read:issues', 'write:issues', 'read:projects', 'write:projects'] as const;
export type Scope = (typeof VALID_SCOPES)[number];

export type Family = 'admin' | 'issues' | 'projects' | 'common' | 'other';

const ADMIN_PREFIXES = [
  '/rest/api/2/admin',
  '/scim',
  '/rest/api/2/migration',
  '/rest/api/2/csv',
  '/rest/api/2/mypersonalaccesstokens',
  '/rest/auth/1/sso/settings',
  '/rest/api/2/applicationlink',
  '/rest/api/2/webhook',
  '/rest/api/2/permissionscheme',
  '/rest/api/2/system',
];
const ISSUE_PREFIXES = [
  '/rest/api/2/issue', // issues, comments, worklogs, attachments, transitions, links
  '/rest/api/2/bulk', // bulk issue operations: every replayed single-issue call is checked again
  '/rest/api/2/issuelink',
  '/rest/api/2/search',
  '/rest/api/2/worklog',
  '/rest/api/2/attachment',
  '/rest/api/2/comment',
  '/rest/api/2/agent-runs', // agents report on their runs with write:issues
];
const PROJECT_PREFIXES = [
  '/rest/api/2/project',
  '/rest/api/2/version',
  '/rest/api/2/component',
  '/rest/api/2/board',
  '/rest/api/2/sprint',
  '/rest/agile/1.0',
  '/rest/api/2/role',
];
const COMMON_GET = ['/rest/api/2/myself', '/rest/api/2/serverinfo', '/rest/api/2/issuetype', '/rest/api/2/status', '/rest/api/2/priority', '/rest/api/2/resolution', '/rest/api/2/field', '/rest/api/2/plugins'];

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

export function classify(rawPath: string): Family {
  // Lower-case and collapse duplicate slashes so `//rest/api/2/admin` or case tricks cannot dodge the table.
  const path = rawPath.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  if (ADMIN_PREFIXES.some((p) => under(path, p))) return 'admin';
  if (ISSUE_PREFIXES.some((p) => under(path, p))) return 'issues';
  if (PROJECT_PREFIXES.some((p) => under(path, p))) return 'projects';
  if (COMMON_GET.some((p) => under(path, p))) return 'common';
  return 'other';
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** Old tokens stored `read`/`write`. The exact legacy default behaves as before; other legacy shapes map to read:* / write:*. */
export function normalizeScopes(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  const list = stored.filter((s): s is string => typeof s === 'string');
  if (list.length === 2 && list.includes('read') && list.includes('write')) return ['*'];
  return list.map((s) => (s === 'read' ? 'read:*' : s === 'write' ? 'write:*' : s));
}

export function isAllowed(scopes: string[], method: string, rawPath: string): boolean {
  if (scopes.includes('*') || scopes.includes('admin')) return true;
  const m = method.toUpperCase();
  const family = classify(rawPath);
  if (family === 'admin') return false;
  const safe = SAFE_METHODS.has(m) || (m === 'POST' && /^\/rest\/api\/2\/search\/?$/i.test(rawPath)); // JQL search is a read sent as POST
  const has = (s: string) => scopes.includes(s);
  if (family === 'common') return safe && scopes.length > 0;
  if (family === 'other') return safe ? has('read:*') || has('write:*') : has('write:*');
  if (safe) return has('read:*') || has('write:*') || has(`read:${family}`) || has(`write:${family}`);
  return has('write:*') || has(`write:${family}`);
}

export const tokenScopes = () =>
  createMiddleware<AppContext>(async (c, next) => {
    const raw = c.get('tokenScopes');
    if (raw === null || raw === undefined) return next(); // cookie session or anonymous
    const run = c.get('agentRun');
    if (run) {
      // Short-lived agent run token: deny by default, only the run's own issue/project (agents/auth.ts).
      const p = c.req.path;
      if (!(await runTokenAllows(run, c.req.method, p))) return c.json({ errorMessages: ['This run token does not permit this request'] }, 403);
      return next();
    }
    const scopes = normalizeScopes(raw);
    const path = c.req.path;
    if (!isAllowed(scopes, c.req.method, path)) {
      return c.json({ errorMessages: ['Token scope does not permit this request'] }, 403);
    }
    await next();
  });
