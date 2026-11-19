/**
 * Fire-and-forget helpers for publishing realtime invalidation events from request handlers.
 * Every helper swallows errors: realtime must never fail or slow down a REST request.
 * Events carry only {type, key, projectId, actorId, at} (no field values, no comment bodies).
 */
import { eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { publish, type EventType } from './hub';

/** Publish for an issue response object (has key + fields.project.id). */
export function publishIssue(type: EventType, issue: { key: string; fields?: any } | null | undefined, actorId?: number | null): void {
  const projectId = issue?.fields?.project?.id;
  if (!issue || typeof projectId !== 'number') return;
  // Secured issues are not announced on project channels (the key would reach people who cannot see the issue).
  if (issue.fields?.security) return;
  publish(type, { key: issue.key, projectId, actorId });
}

/** Publish for an issue identified by internal id (resolves key/project asynchronously). */
export function publishIssueById(type: EventType, issueId: number, actorId?: number | null): void {
  void db
    .select({ key: schema.issues.issueKey, projectId: schema.issues.projectId, level: schema.issues.securityLevelId })
    .from(schema.issues)
    .where(eq(schema.issues.id, issueId))
    .limit(1)
    .then(([i]) => i && i.level === null && publish(type, { key: i.key, projectId: i.projectId, actorId }))
    .catch(() => {});
}

/** board.updated for a board id. */
export function publishBoard(boardId: number, actorId?: number | null, type: EventType = 'board.updated'): void {
  void db
    .select({ projectId: schema.boards.projectId })
    .from(schema.boards)
    .where(eq(schema.boards.id, boardId))
    .limit(1)
    .then(([b]) => b?.projectId && publish(type, { key: boardId, projectId: b.projectId, actorId }))
    .catch(() => {});
}

/** sprint.updated for a sprint id (resolves board -> project). */
export function publishSprint(sprintId: number, actorId?: number | null): void {
  void db
    .select({ projectId: schema.boards.projectId })
    .from(schema.sprints)
    .innerJoin(schema.boards, eq(schema.boards.id, schema.sprints.boardId))
    .where(eq(schema.sprints.id, sprintId))
    .limit(1)
    .then(([r]) => r?.projectId && publish('sprint.updated', { key: sprintId, projectId: r.projectId, actorId }))
    .catch(() => {});
}

/** sprint.updated when the board id is already known. */
export function publishSprintForBoard(boardId: number, sprintId: number, actorId?: number | null): void {
  void db
    .select({ projectId: schema.boards.projectId })
    .from(schema.boards)
    .where(eq(schema.boards.id, boardId))
    .limit(1)
    .then(([b]) => b?.projectId && publish('sprint.updated', { key: sprintId, projectId: b.projectId, actorId }))
    .catch(() => {});
}
