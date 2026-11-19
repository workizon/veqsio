/**
 * Archived projects are read-only. One small global guard answers every write (POST/PUT/PATCH/DELETE) that targets
 * an archived project with 409 and a clear message, before any handler runs. It finds the project from the URL
 * (issue, board, sprint, worklog, comment, attachment, project key) and, for creating things, from the request body.
 * Only signed-in callers are looked at, so an anonymous request still gets its normal 401 and learns nothing.
 *
 * Not blocked on purpose: restoring (POST /project/:key/restore) and deleting (DELETE /project/:key, which itself
 * requires the project to be archived).
 */
import { createMiddleware } from 'hono/factory';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import type { AppContext } from '../auth/middleware';
import { projectIdOfIssue } from '../middleware/permissions';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const ARCHIVED_MESSAGE = 'This project is archived and read-only. A project administrator can restore it first.';

const idOf = (s: string | undefined) => (s && /^\d{1,9}$/.test(s) ? Number(s) : null);

export function isLifecycleException(method: string, path: string): boolean {
  return (method === 'POST' && /^\/rest\/api\/2\/project\/[^/]+\/restore\/?$/.test(path)) || (method === 'DELETE' && /^\/rest\/api\/2\/project\/[^/]+\/?$/.test(path));
}

async function projectIdFromPath(path: string): Promise<number | null> {
  let m: RegExpExecArray | null;
  if ((m = /^\/rest\/api\/2\/issue\/([^/]+)/.exec(path)) && !['bulk', 'import', 'similar', 'ai'].includes(m[1])) return projectIdOfIssue(decodeURIComponent(m[1]));
  if ((m = /^\/rest\/api\/2\/issue-template\/(\d+)/.exec(path))) {
    const rows = await db.select({ p: schema.issueTemplates.projectId }).from(schema.issueTemplates).where(eq(schema.issueTemplates.id, Number(m[1]))).limit(1);
    return rows[0]?.p ?? null;
  }
  if ((m = /^\/rest\/api\/2\/project\/([^/]+)/.exec(path))) {
    const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.projectKey, decodeURIComponent(m[1]))).limit(1);
    return rows[0]?.id ?? null;
  }
  if ((m = /^\/rest\/(?:api\/2|agile\/1\.0)\/board\/(\d+)/.exec(path))) {
    const rows = await db.select({ p: schema.boards.projectId }).from(schema.boards).where(eq(schema.boards.id, Number(m[1]))).limit(1);
    return rows[0]?.p ?? null;
  }
  if ((m = /^\/rest\/(?:api\/2|agile\/1\.0)\/sprint\/(\d+)/.exec(path))) {
    const rows = await db.select({ p: schema.boards.projectId }).from(schema.sprints).innerJoin(schema.boards, eq(schema.boards.id, schema.sprints.boardId)).where(eq(schema.sprints.id, Number(m[1]))).limit(1);
    return rows[0]?.p ?? null;
  }
  if ((m = /^\/rest\/api\/2\/worklog\/(\d+)/.exec(path))) {
    const rows = await db.select({ p: schema.issues.projectId }).from(schema.worklogs).innerJoin(schema.issues, eq(schema.issues.id, schema.worklogs.issueId)).where(eq(schema.worklogs.id, Number(m[1]))).limit(1);
    return rows[0]?.p ?? null;
  }
  if ((m = /^\/rest\/api\/2\/comment\/(\d+)/.exec(path))) {
    const rows = await db.select({ p: schema.issues.projectId }).from(schema.comments).innerJoin(schema.issues, eq(schema.issues.id, schema.comments.issueId)).where(eq(schema.comments.id, Number(m[1]))).limit(1);
    return rows[0]?.p ?? null;
  }
  if ((m = /^\/rest\/api\/2\/attachment\/(\d+)/.exec(path))) {
    const rows = await db.select({ p: schema.issues.projectId }).from(schema.attachments).innerJoin(schema.issues, eq(schema.issues.id, schema.attachments.issueId)).where(eq(schema.attachments.id, Number(m[1]))).limit(1);
    return rows[0]?.p ?? null;
  }
  return null;
}

/** Project ids named in the body of the few create endpoints that carry the project there (by id or by key). */
async function projectIdsFromBody(method: string, path: string, read: () => Promise<any>): Promise<number[]> {
  if (method !== 'POST') return [];
  const ids: number[] = [];
  const keys: string[] = [];
  if (/^\/rest\/api\/2\/issue\/?$/.test(path) || /^\/rest\/api\/2\/issue\/(bulk|import)\/?$/.test(path)) {
    const b = await read();
    const one = (x: any) => {
      const p = x?.fields?.project ?? x?.project;
      const id = p && typeof p === 'object' ? p.id : p;
      if (idOf(String(id ?? ''))) ids.push(Number(id));
      else if (p && typeof p === 'object' && typeof p.key === 'string') keys.push(p.key);
    };
    if (Array.isArray(b?.issueUpdates)) b.issueUpdates.slice(0, 50).forEach(one);
    else if (Array.isArray(b?.issues)) b.issues.slice(0, 50).forEach(one);
    else one(b);
  } else if (/^\/rest\/api\/2\/issue-template(\/\d+\/issue)?\/?$/.test(path)) {
    const b = await read();
    if (typeof b?.projectKey === 'string') keys.push(b.projectKey);
  } else if (/^\/rest\/(api\/2|agile\/1\.0)\/board\/?$/.test(path)) {
    const b = await read();
    if (idOf(String(b?.projectId ?? ''))) ids.push(Number(b.projectId));
  } else if (path === '/rest/api/2/issueLink') {
    const b = await read();
    for (const k of [b?.inwardIssue?.key, b?.outwardIssue?.key]) if (typeof k === 'string') { const pid = await projectIdOfIssue(k); if (pid) ids.push(pid); }
  }
  if (keys.length) {
    const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(inArray(schema.projects.projectKey, keys.map((k) => k.toUpperCase())));
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

export async function archivedAmong(ids: number[]): Promise<boolean> {
  if (!ids.length) return false;
  const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(inArray(schema.projects.id, ids), isNotNull(schema.projects.archivedAt))).limit(1);
  return rows.length > 0;
}

export function archiveGuard() {
  return createMiddleware<AppContext>(async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if (!WRITE.has(method) || !path.startsWith('/rest/') || isLifecycleException(method, path)) return next();
    if (!c.get('user')) return next();
    try {
      const ids: number[] = [];
      const fromPath = await projectIdFromPath(path);
      if (fromPath) ids.push(fromPath);
      ids.push(...await projectIdsFromBody(method, path, () => c.req.json().catch(() => null)));
      if (await archivedAmong(ids)) return c.json({ errorMessages: [ARCHIVED_MESSAGE] }, 409);
    } catch (e) {
      console.error('[archive-guard]', (e as Error).message);
    }
    return next();
  });
}
