/**
 * Cloud mode (VEQSIO_CLOUD=1): this instance is a managed tenant. The operator (the control plane) owns deployment,
 * licence, backups and outbound mail; the customer's administrators own everything inside the product.
 * Self-hosted installs never set it, so nothing here changes their behaviour.
 */
import { createMiddleware } from 'hono/factory';
import type { AppContext } from '../auth/middleware';

export const isCloud = (env: NodeJS.ProcessEnv = process.env) => env.VEQSIO_CLOUD === '1';

export const CLOUD_REFUSAL = 'This setting is managed by Veqsio Cloud.';

/** Writes that are refused in cloud mode: licence paste, backup/restore of the database, mail server, deployment settings. */
const BLOCKED: RegExp[] = [
  /^\/rest\/api\/2\/admin\/license/,
  /^\/rest\/api\/2\/admin\/system\/(backup|mail)/,
  /^\/rest\/api\/2\/admin\/system\/config/,
];
/** Reads that expose deployment internals or hand out the whole database. */
const BLOCKED_READS: RegExp[] = [
  /^\/rest\/api\/2\/admin\/system\/backup/,
  /^\/rest\/api\/2\/admin\/health-check/,
];

export function isBlockedInCloud(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return BLOCKED_READS.some((re) => re.test(path));
  return BLOCKED.some((re) => re.test(path));
}

/** Server-side enforcement: hiding the pages in the UI is not a control. */
export function cloudMode() {
  return createMiddleware<AppContext>(async (c, next) => {
    if (!isCloud()) return next();
    const url = new URL(c.req.url);
    if (isBlockedInCloud(c.req.method, c.req.path)) return c.json({ errorMessages: [CLOUD_REFUSAL], cloudManaged: true }, 403);
    return next();
  });
}
