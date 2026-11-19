/**
 * Inbound webhook processing: turns an authenticated payload of a source into an action on an issue.
 *
 *   dedup key unknown / issue done  -> create an issue
 *   dedup key of an open issue      -> add a comment
 *   payload says "resolved"         -> transition the open issue to a done status
 *
 * Retries never duplicate: a delivery that carries an idempotency key is claimed with a unique insert first. The
 * create / comment / resolve decision for one dedup key runs under a transaction-scoped advisory lock, so two
 * simultaneous alerts with the same fingerprint cannot both create an issue.
 * The source's actor user is the reporter / commenter; every action is checked against that user's permissions.
 */
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { createIssue, invalidateIssueKeyCache } from '../issues/service';
import { invalidateIssueCache } from '../middleware/cache';
import { checkProjectPermission } from '../middleware/permissions';
import { getAvailableTransitions, doTransition } from '../workflow/engine';
import { notifyIssueCreated, notifyCommentAdded } from '../services/notifications';
import { publishIssue, publishIssueById } from '../realtime/publish';
import { applyMapping, type Normalized } from './mapping';
import { normalizeSentry } from './sentry';
import { redactPayload } from './redact';

export type Source = typeof schema.inboundSources.$inferSelect;
export type InboundStatus = 'created' | 'commented' | 'transitioned' | 'ignored' | 'duplicate' | 'rejected' | 'error';

export interface InboundResult { status: InboundStatus; httpStatus: number; issueKey?: string; reason?: string }

const KEEP_DELIVERIES = 100;

export function normalizeFor(source: Pick<Source, 'type' | 'mapping'>, payload: unknown): Normalized | null {
  if (source.type === 'sentry') {
    const pm = (source.mapping as { priorityMap?: Record<string, string> } | null)?.priorityMap;
    return normalizeSentry(payload, pm && Object.keys(pm).length ? pm : undefined);
  }
  return applyMapping(source.mapping, payload);
}

type Existing = { id: number; key: string; done: boolean };
export type Plan =
  | { action: 'create' }
  | { action: 'comment'; issue: Existing }
  | { action: 'transition'; issue: Existing }
  | { action: 'ignore'; reason: string };

async function findLinked(sourceId: number, dedupKey: string): Promise<Existing | null> {
  const [row] = await db.select({ id: schema.issues.id, key: schema.issues.issueKey, category: schema.statuses.category })
    .from(schema.inboundLinks)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.inboundLinks.issueId))
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .where(and(eq(schema.inboundLinks.sourceId, sourceId), eq(schema.inboundLinks.dedupKey, dedupKey))).limit(1);
  return row ? { id: row.id, key: row.key, done: row.category === 'done' } : null;
}

/** Read-only decision, used by the dry-run preview and by the real run (inside the lock). */
export async function planInbound(source: Pick<Source, 'id'>, n: Normalized): Promise<Plan> {
  const linked = n.dedupKey ? await findLinked(source.id, n.dedupKey) : null;
  if (n.resolved) {
    if (!n.dedupKey) return { action: 'ignore', reason: 'Resolved payload without a dedup key: nothing to resolve' };
    if (!linked || linked.done) return { action: 'ignore', reason: 'No open issue for this dedup key' };
    return { action: 'transition', issue: linked };
  }
  if (linked && !linked.done) return { action: 'comment', issue: linked };
  return { action: 'create' };
}

async function priorityIdByName(name: string | null): Promise<number | undefined> {
  if (!name) return undefined;
  const [p] = await db.select({ id: schema.priorities.id }).from(schema.priorities).where(sql`lower(${schema.priorities.name}) = ${name.toLowerCase()}`).limit(1);
  return p?.id;
}

async function defaultIssueTypeId(source: Source): Promise<number | undefined> {
  if (source.issueTypeId) return source.issueTypeId;
  const [assoc] = await db.select({ schemeId: schema.issueTypeSchemeAssociations.schemeId }).from(schema.issueTypeSchemeAssociations)
    .where(eq(schema.issueTypeSchemeAssociations.projectId, source.projectId)).limit(1);
  if (assoc) {
    const [t] = await db.select({ id: schema.issueTypes.id }).from(schema.issueTypeSchemeItems)
      .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issueTypeSchemeItems.issueTypeId))
      .where(and(eq(schema.issueTypeSchemeItems.schemeId, assoc.schemeId), eq(schema.issueTypes.isSubtask, false))).orderBy(schema.issueTypes.id).limit(1);
    if (t) return t.id;
  }
  const [t] = await db.select({ id: schema.issueTypes.id }).from(schema.issueTypes).where(eq(schema.issueTypes.isSubtask, false)).orderBy(schema.issueTypes.id).limit(1);
  return t?.id;
}

class Misconfigured extends Error {}

async function getActor(source: Source) {
  if (!source.actorUserId) throw new Misconfigured('The source has no actor user');
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, source.actorUserId)).limit(1);
  if (!u || u.active === false) throw new Misconfigured('The actor user of this source is missing or deactivated');
  return u;
}

async function execute(source: Source, n: Normalized): Promise<InboundResult & { dedupKey: string | null; issueId?: number }> {
  const actor = await getActor(source);
  const key = n.dedupKey;
  const run = async () => {
    const plan = await planInbound(source, n);
    switch (plan.action) {
      case 'ignore': return { status: 'ignored' as const, httpStatus: 200, reason: plan.reason };
      case 'comment': {
        if (!(await checkProjectPermission(actor, source.projectId, 'ADD_COMMENTS'))) throw new Misconfigured('The actor user may not comment in this project');
        const [comment] = await db.insert(schema.comments).values({ issueId: plan.issue.id, body: n.comment.slice(0, 20_000), authorId: actor.id }).returning();
        await invalidateIssueCache(plan.issue.key);
        publishIssueById('comment.added', plan.issue.id, actor.id);
        try {
          const [row] = await db.select().from(schema.issues).where(eq(schema.issues.id, plan.issue.id)).limit(1);
          if (row) await notifyCommentAdded(comment, row, undefined, [actor.id]);
        } catch (e) { console.error('[inbound] comment notification failed:', (e as Error)?.name); }
        return { status: 'commented' as const, httpStatus: 200, issueKey: plan.issue.key, issueId: plan.issue.id };
      }
      case 'transition': {
        if (!(await checkProjectPermission(actor, source.projectId, 'TRANSITION_ISSUES'))) throw new Misconfigured('The actor user may not transition issues in this project');
        const available = await getAvailableTransitions(plan.issue.id, actor.id);
        const t = available.find((a: any) => a.to?.statusCategory === 'done');
        if (!t) return { status: 'ignored' as const, httpStatus: 200, reason: 'No transition to a done status is available from the current status', issueKey: plan.issue.key, issueId: plan.issue.id };
        await doTransition(plan.issue.id, t.id, actor.id, {}, {});
        await invalidateIssueKeyCache(plan.issue.key);
        await invalidateIssueCache(plan.issue.key);
        publishIssueById('issue.updated', plan.issue.id, actor.id);
        return { status: 'transitioned' as const, httpStatus: 200, issueKey: plan.issue.key, issueId: plan.issue.id };
      }
      case 'create': {
        if (!(await checkProjectPermission(actor, source.projectId, 'CREATE_ISSUES'))) throw new Misconfigured('The actor user may not create issues in this project');
        const issueTypeId = await defaultIssueTypeId(source);
        if (!issueTypeId) throw new Misconfigured('No issue type is available for this source');
        const footer = `\n\n---\nCreated by inbound webhook source "${source.name}". The text above comes from an external system.`;
        const issue = await createIssue({
          projectId: source.projectId, issueTypeId, summary: n.summary, description: (n.description + footer).slice(0, 30_000),
          priorityId: await priorityIdByName(n.priority), labels: n.labels.length ? n.labels : undefined,
        }, actor.id);
        const [{ id }] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, issue.key)).limit(1);
        if (key) {
          await db.insert(schema.inboundLinks).values({ sourceId: source.id, dedupKey: key, issueId: id })
            .onConflictDoUpdate({ target: [schema.inboundLinks.sourceId, schema.inboundLinks.dedupKey], set: { issueId: id, createdAt: new Date() } });
        }
        await invalidateIssueCache(issue.key);
        publishIssue('issue.created', issue, actor.id);
        try {
          const [row] = await db.select().from(schema.issues).where(eq(schema.issues.id, id)).limit(1);
          if (row) await notifyIssueCreated(row);
        } catch (e) { console.error('[inbound] issue notification failed:', (e as Error)?.name); }
        return { status: 'created' as const, httpStatus: 201, issueKey: issue.key, issueId: id };
      }
    }
  };
  const out = key
    ? await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${source.id}::int, hashtext(${key}::text))`);
        return run();
      })
    : await run();
  return { ...out, dedupKey: key };
}

async function pruneDeliveries(sourceId: number) {
  await db.execute(sql`delete from inbound_deliveries where source_id = ${sourceId} and id not in (select id from inbound_deliveries where source_id = ${sourceId} order by id desc limit ${KEEP_DELIVERIES})`);
}

export interface ReceiveOptions { rawBody: string; payload: unknown; headerIdempotencyKey: string | null; isTest?: boolean }

/** Process one authenticated delivery and log it. Never throws for expected failures. */
export async function receive(source: Source, o: ReceiveOptions): Promise<InboundResult> {
  const stored = redactPayload(o.rawBody);
  const n = normalizeFor(source, o.payload);
  const idem = o.headerIdempotencyKey ?? n?.idempotencyKey ?? null;

  const [claim] = await db.insert(schema.inboundDeliveries).values({
    sourceId: source.id, status: 'processing', idempotencyKey: idem, payload: stored, isTest: !!o.isTest, dedupKey: n?.dedupKey?.slice(0, 300) ?? null,
  }).onConflictDoNothing().returning({ id: schema.inboundDeliveries.id });
  if (!claim) return { status: 'duplicate', httpStatus: 200, reason: 'Idempotency key already processed' };

  const finish = async (r: InboundResult & { issueId?: number }, clearKey = false) => {
    await db.update(schema.inboundDeliveries).set({
      status: r.status, reason: r.reason?.slice(0, 500) ?? null, issueId: r.issueId ?? null,
      ...(clearKey ? { idempotencyKey: null } : {}),
    }).where(eq(schema.inboundDeliveries.id, claim.id));
    await pruneDeliveries(source.id);
    return r;
  };

  if (!n) return finish({ status: 'ignored', httpStatus: 200, reason: 'Payload not recognised' });
  try {
    const r = await execute(source, n);
    return await finish(r);
  } catch (e) {
    if (e instanceof Misconfigured) {
      await finish({ status: 'rejected', httpStatus: 422, reason: e.message }, true);
      return { status: 'rejected', httpStatus: 422, reason: 'The source is not configured correctly' };
    }
    console.error('[inbound] processing failed:', (e as Error)?.name, (e as Error)?.message?.slice(0, 200));
    // Release the idempotency key so the sender's retry is processed.
    await finish({ status: 'error', httpStatus: 500, reason: (e as Error)?.message?.slice(0, 300) || 'Processing failed' }, true).catch(() => {});
    return { status: 'error', httpStatus: 500, reason: 'Internal error' };
  }
}

export interface DryRun { normalized: Normalized | null; plan: Plan | null; note?: string }

/** Preview for the test dialog: what would happen with this payload, without touching anything. */
export async function dryRun(source: Source, payload: unknown): Promise<DryRun> {
  const normalized = normalizeFor(source, payload);
  if (!normalized) return { normalized: null, plan: null, note: 'The payload is not recognised by this source and would be ignored.' };
  return { normalized, plan: await planInbound(source, normalized) };
}
