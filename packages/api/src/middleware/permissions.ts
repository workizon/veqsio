import { createMiddleware } from 'hono/factory';
import type { AppContext } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import { evaluateGlobal, evaluateProject, evaluateIssueAccess, entryGrantsSql } from '../permissions/evaluate';

/* ------------------------------------------------------------------ */
/*  Helpers to resolve project context from URL parameters             */
/* ------------------------------------------------------------------ */

export async function issueRefOf(idOrKey: string): Promise<{ id: number; projectId: number } | null> {
  const num = Number(idOrKey);
  const where = /^\d+$/.test(idOrKey) && Number.isSafeInteger(num) && num < 2147483647
    ? eq(schema.issues.id, num)
    : eq(schema.issues.issueKey, idOrKey);
  const rows = await db.select({ id: schema.issues.id, projectId: schema.issues.projectId }).from(schema.issues).where(where).limit(1);
  return rows[0] ?? null;
}

export async function projectIdOfIssue(idOrKey: string): Promise<number | null> {
  return (await issueRefOf(idOrKey))?.projectId ?? null;
}

const asId = (v: string | undefined): number | null => {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  return Number(v);
};

/**
 * Which project does this request act on? Looks at the URL only (never the body):
 *  - /issue/<key|id>/...   -> the issue's project
 *  - /board/<id>, /board/<id>/... and agile :boardId -> the board's project
 *  - /sprint/<id>, agile :sprintId -> the sprint's board's project
 *  - /worklog/<id> -> the worklog's issue's project
 *  - comment / attachment ids -> via their issue
 *  - /project/<key>/... -> that project
 * null means "no resource in the URL" (or it does not exist); callers then fall back to the global permission.
 */
async function resolveProjectId(c: any): Promise<number | null> {
  const path: string = c.req.path;

  const issueSeg = /\/issue\/([^/]+)/.exec(path)?.[1];
  const idOrKey = c.req.param('idOrKey') ?? (issueSeg ? decodeURIComponent(issueSeg) : undefined);
  if (idOrKey) return projectIdOfIssue(idOrKey);

  const boardId = asId(c.req.param('boardId')) ?? (/\/board\/(\d+)/.test(path) ? asId(/\/board\/(\d+)/.exec(path)![1]) : null);
  if (boardId) {
    const rows = await db.select({ projectId: schema.boards.projectId }).from(schema.boards).where(eq(schema.boards.id, boardId)).limit(1);
    return rows[0]?.projectId ?? null;
  }

  const sprintId = asId(c.req.param('sprintId')) ?? (/\/sprint\/(\d+)/.test(path) ? asId(/\/sprint\/(\d+)/.exec(path)![1]) : null);
  if (sprintId) {
    const rows = await db
      .select({ projectId: schema.boards.projectId })
      .from(schema.sprints)
      .innerJoin(schema.boards, eq(schema.boards.id, schema.sprints.boardId))
      .where(eq(schema.sprints.id, sprintId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  const worklogId = /\/worklog\/(\d+)/.exec(path)?.[1];
  if (worklogId) {
    const rows = await db
      .select({ projectId: schema.issues.projectId })
      .from(schema.worklogs)
      .innerJoin(schema.issues, eq(schema.issues.id, schema.worklogs.issueId))
      .where(eq(schema.worklogs.id, Number(worklogId)))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  const key = c.req.param('key');
  if (key) {
    const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
    return rows[0]?.id ?? null;
  }

  const commentId = asId(c.req.param('commentId'));
  if (commentId) {
    const cRows = await db.select({ issueId: schema.comments.issueId }).from(schema.comments).where(eq(schema.comments.id, commentId)).limit(1);
    if (cRows[0]?.issueId) {
      const iRows = await db.select({ projectId: schema.issues.projectId }).from(schema.issues).where(eq(schema.issues.id, cRows[0].issueId)).limit(1);
      return iRows[0]?.projectId ?? null;
    }
  }

  const attachmentId = asId(c.req.param('id'));
  if (attachmentId && path.includes('attachment')) {
    const aRows = await db.select({ issueId: schema.attachments.issueId }).from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).limit(1);
    if (aRows[0]?.issueId) {
      const iRows = await db.select({ projectId: schema.issues.projectId }).from(schema.issues).where(eq(schema.issues.id, aRows[0].issueId)).limit(1);
      return iRows[0]?.projectId ?? null;
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Core permission checking functions                                  */
/* ------------------------------------------------------------------ */

export async function checkGlobalPermission(
  user: typeof schema.users.$inferSelect,
  permission: string
): Promise<boolean> {
  return (await evaluateGlobal(user, permission)).allowed;
}

export { entryGrantsSql };

export async function checkProjectPermission(
  user: typeof schema.users.$inferSelect | null,
  projectId: number,
  permission: string
): Promise<boolean> {
  return (await evaluateProject(user, projectId, permission)).allowed;
}

/** IDs of all projects the user may browse (BROWSE_PROJECTS). Use to scope cross-project aggregates. */
export async function getBrowsableProjectIds(
  user: typeof schema.users.$inferSelect | null,
): Promise<number[]> {
  const projects = await db.select({ id: schema.projects.id }).from(schema.projects);
  const allowed = await Promise.all(
    projects.map(async (p) => ((await checkProjectPermission(user, p.id, 'BROWSE_PROJECTS')) ? p.id : null)),
  );
  return allowed.filter((id): id is number => id !== null);
}

export const checkPermission = checkProjectPermission;

/* ------------------------------------------------------------------ */
/*  Middleware factory                                                  */
/* ------------------------------------------------------------------ */

export function requirePermission(permission: string) {
  return createMiddleware<AppContext>(async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ errorMessages: ['Authentication required'] }, 401);
    }

    const projectId = await resolveProjectId(c);

    if (projectId) {
      const allowed = await checkProjectPermission(user, projectId, permission);
      if (!allowed) {
        return c.json({ errorMessages: ['Forbidden'] }, 403);
      }
    } else {
      const allowed = await checkGlobalPermission(user, permission);
      if (!allowed) {
        return c.json({ errorMessages: ['Forbidden'] }, 403);
      }
    }

    await next();
  });
}

export function requireProjectPermission(permission: string) {
  return createMiddleware<AppContext>(async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ errorMessages: ['Authentication required'] }, 401);
    }

    const key = c.req.param('key');
    if (!key) {
      return c.json({ errorMessages: ['Project key required'] }, 400);
    }

    const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
    if (rows.length === 0) {
      return c.json({ errorMessages: ['Project not found'] }, 404);
    }

    const allowed = await checkProjectPermission(user, rows[0].id, permission);
    if (!allowed) {
      return c.json({ errorMessages: ['Forbidden'] }, 403);
    }

    await next();
  });
}

/**
 * Guard for routes that act on one issue (/issue/:idOrKey/... or /issue/:key/...).
 * Without BROWSE_PROJECTS on the issue's project the issue does not exist as far as the caller can tell (404, so keys
 * cannot be enumerated); with it but without `permission` the answer is 403. A missing issue is a plain 404.
 */
export function requireIssueAccess(permission: string = 'BROWSE_PROJECTS') {
  return createMiddleware<AppContext>(async (c, next) => {
    const user = c.get('user');
    if (!user) return c.json({ errorMessages: ['Authentication required'] }, 401);
    const raw = c.req.param('idOrKey') ?? c.req.param('key');
    if (!raw) return c.json({ errorMessages: ['Issue not found'] }, 404);
    const ref = await issueRefOf(raw);
    if (ref === null) return c.json({ errorMessages: ['Issue not found'] }, 404);
    const access = await evaluateIssueAccess(user, ref.projectId, permission, false, ref.id);
    if (access.outcome === 'hidden') {
      return c.json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, 404);
    }
    if (access.outcome === 'forbidden') {
      return c.json({ errorMessages: ['Forbidden'] }, 403);
    }
    await next();
  });
}
