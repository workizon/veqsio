import { createMiddleware } from 'hono/factory';
import type { AppContext } from '../auth/middleware';

/**
 * Public demo guard (VEQSIO_DEMO=1). The demo signs every visitor in as an administrator and is reset on a schedule, so
 * the data does not need protecting, but the server must not be usable to reach other systems or to lock the demo up:
 * outgoing mail, webhooks, git and chat integrations, imports from other tools, SSO/LDAP/SCIM and AI provider settings,
 * plug-ins, licence, backup and restore, system configuration, and changes to the administrator account itself.
 * Reading is never blocked; the response says why a write was refused.
 */
export const DEMO_REFUSAL = 'This function is switched off in the public demo.';

const BLOCKED: RegExp[] = [
  /^\/rest\/api\/2\/admin\/system\/(mail|config|backup|storage)/,
  /^\/rest\/api\/2\/admin\/(license|ai|ldap|oidc|saml|scim|plugins|notification-channels|config\/import)/,
  /^\/rest\/api\/2\/plugins(\/|$)/,
  /^\/rest\/api\/2\/webhooks?(\/|$)/,
  /^\/rest\/api\/2\/migration(\/|$)/,
  /^\/rest\/api\/2\/csv-import\/run/,
  /^\/rest\/api\/2\/project\/[^/]+\/(notification-channels|repositories|restore|intake\/settings)/,
  /^\/rest\/api\/2\/intake\/[^/]+\/email/,
  /^\/rest\/auth\/1\/(sso\/settings|saml(\/|$)|oidc(\/|$))/,
  /^\/rest\/auth\/1\/password-reset\//,
  /^\/rest\/servicedeskapi\/(inbound-email|servicedesk\/[^/]+\/email-channel)/,
  /^\/rest\/webhooks\//,
  /^\/rest\/api\/2\/issue\/import/,
];

/** Reads that hand out bulk data: switched off in the demo as well. */
const BLOCKED_READS: RegExp[] = [
  /^\/rest\/api\/2\/admin\/system\/backup/,
  /^\/rest\/api\/2\/admin\/config\/export/,
  /^\/rest\/api\/2\/admin\/audit\/export/,
];

const PROTECTED_USERS = new Set(['admin']);

/** True when a write to `path` must be refused in the demo. `body` is the parsed JSON body of user/group changes. */
export function isBlockedInDemo(method: string, path: string, query: URLSearchParams, body?: any): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return BLOCKED_READS.some((re) => re.test(path));
  if (BLOCKED.some((re) => re.test(path))) return true;
  // the administrator account must stay usable: no deleting, deactivating or password change for it; no leaving the admin group
  if (/^\/rest\/api\/2\/user(\/|$)/.test(path)) {
    const name = (query.get('username') || body?.username || body?.key || '').toString().toLowerCase();
    if (method === 'DELETE') return PROTECTED_USERS.has(name) || name === '';
    if (PROTECTED_USERS.has(name) && (body?.password !== undefined || body?.active === false)) return true;
    if (name === '' && body?.password !== undefined) return true;
  }
  if (/^\/rest\/api\/2\/group(\/|$)/.test(path)) {
    if (method === 'DELETE' && /administrators/i.test(query.get('groupname') || '') ) return true;
    if (method === 'DELETE' && path.endsWith('/user') && PROTECTED_USERS.has((query.get('username') || '').toLowerCase())) return true;
  }
  return false;
}

export function demoMode() {
  return createMiddleware<AppContext>(async (c, next) => {
    if (process.env.VEQSIO_DEMO !== '1') return next();
    const method = c.req.method;
    const url = new URL(c.req.url);
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      if (isBlockedInDemo(method, c.req.path, url.searchParams)) return c.json({ errorMessages: [DEMO_REFUSAL], demo: true }, 403);
      return next();
    }
    let body: any;
    if (/^\/rest\/api\/2\/user/.test(c.req.path) && (c.req.header('content-type') || '').includes('json')) {
      body = await c.req.json().catch(() => undefined);
    }
    if (isBlockedInDemo(method, c.req.path, url.searchParams, body)) {
      return c.json({ errorMessages: [DEMO_REFUSAL], demo: true }, 403);
    }
    return next();
  });
}
