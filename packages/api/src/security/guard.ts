/**
 * One request guard for the issue security rule: every URL that names an issue (directly by key or id, or through an
 * attachment, worklog, issue link or service request) answers 404 when the caller is logged in and the issue's security
 * level hides it from them. Mounted once in app.ts, before the routes, so no route can forget it.
 * (Lists and aggregates do not go through here: they add `issueVisibleSql` to their own query.)
 */
import type { MiddlewareHandler } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import type { AppContext } from '../auth/middleware';
import { issueVisibleSql } from './issue-security';

const NOT_FOUND = { errorMessages: ['Issue does not exist or you do not have permission to see it.'] };
/** /issue/<segment> values that are not issue references. */
const RESERVED = new Set(['createmeta', 'bulk', 'import', 'similar', 'ai', 'search']);

type Target = { kind: 'issue'; ref: string } | { kind: 'attachment' | 'worklog' | 'link' | 'approval'; id: number };

export function targetsOfPath(path: string): Target[] {
  const out: Target[] = [];
  const issue = /\/(?:issues?|request)\/([^/]+)/.exec(path)?.[1];
  if (issue) {
    let ref = issue;
    try { ref = decodeURIComponent(issue); } catch { /* keep raw */ }
    if (!RESERVED.has(ref)) out.push({ kind: 'issue', ref });
  }
  const id = (re: RegExp) => { const m = re.exec(path)?.[1]; return m && /^\d{1,9}$/.test(m) ? Number(m) : null; };
  const att = id(/\/attachment\/(\d+)/); if (att) out.push({ kind: 'attachment', id: att });
  const wl = id(/\/worklog\/(\d+)/); if (wl) out.push({ kind: 'worklog', id: wl });
  const ap = id(/\/approval\/(\d+)/); if (ap) out.push({ kind: 'approval', id: ap });
  const lk = id(/\/issueLink\/(\d+)/); if (lk) out.push({ kind: 'link', id: lk });
  return out;
}

async function hidden(userId: number, t: Target): Promise<boolean> {
  const vis = issueVisibleSql(userId, 'i');
  let rows: Array<{ ok: boolean }>;
  if (t.kind === 'issue') {
    const num = /^\d{1,9}$/.test(t.ref) ? Number(t.ref) : null;
    // Only an existing issue can be hidden; unknown keys fall through to the route's own 404.
    rows = (await db.execute(sql`SELECT (${vis}) AS ok FROM issues i WHERE ${num !== null ? sql`i.id = ${num}` : sql`i.issue_key = ${t.ref}`} LIMIT 1`)) as any;
  } else if (t.kind === 'attachment') {
    rows = (await db.execute(sql`SELECT (${vis}) AS ok FROM attachments a JOIN issues i ON i.id = a.issue_id WHERE a.id = ${t.id} LIMIT 1`)) as any;
  } else if (t.kind === 'approval') {
    rows = (await db.execute(sql`SELECT (${vis}) AS ok FROM approvals a JOIN issues i ON i.id = a.issue_id WHERE a.id = ${t.id} LIMIT 1`)) as any;
  } else if (t.kind === 'worklog') {
    rows = (await db.execute(sql`SELECT (${vis}) AS ok FROM worklogs w JOIN issues i ON i.id = w.issue_id WHERE w.id = ${t.id} LIMIT 1`)) as any;
  } else {
    // A link is hidden when either end is hidden.
    rows = (await db.execute(sql`SELECT (${vis}) AS ok FROM issue_links l JOIN issues i ON i.id IN (l.issue_id, l.linked_issue_id) WHERE l.id = ${t.id}`)) as any;
  }
  return rows.some((r) => r.ok === false);
}

export function issueSecurityGuard(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) return next();
    const targets = targetsOfPath(c.req.path);
    for (const t of targets) {
      if (await hidden(user.id, t)) return c.json(NOT_FOUND, 404);
    }
    return next();
  };
}
