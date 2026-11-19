/**
 * Workflow governance: the change history of workflows (who changed which transition, status or condition when),
 * the human readable condition summaries it shows, and the workspace-level `workflowGovernance` setting.
 */
import { desc, eq, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { getInstanceSettings } from '../settings/instance';

export type GovernanceMode = 'any' | 'constrained';

export async function getWorkflowGovernance(): Promise<GovernanceMode> {
  const v = (await getInstanceSettings()).workflowGovernance;
  return v === 'constrained' ? 'constrained' : 'any';
}

export interface ChangeEntry {
  targetType: 'workflow' | 'transition' | 'status' | 'condition' | 'validator' | 'postFunction' | 'scheme';
  action: 'created' | 'updated' | 'deleted' | 'assigned';
  summary: string;
  details?: Record<string, unknown> | null;
}

/** Best effort: the history must never break the admin action itself. */
export async function logWorkflowChange(workflowId: number, actorId: number | null | undefined, entry: ChangeEntry): Promise<void> {
  try {
    await db.insert(schema.workflowChangeLog).values({
      workflowId, actorId: actorId ?? null, targetType: entry.targetType, action: entry.action,
      summary: entry.summary.slice(0, 1000), details: entry.details ?? null,
    });
  } catch (err) {
    console.error('[workflow-log] failed to record change', (err as Error).message);
  }
}

export async function logWorkflowChanges(workflowId: number, actorId: number | null | undefined, entries: ChangeEntry[]) {
  for (const e of entries) await logWorkflowChange(workflowId, actorId, e);
}

type Item = Record<string, unknown>;

/** "Only role Developers" style one-liner for an item of a condition / validator / post-function list. */
export function describeItem(item: Item): string {
  const type = String(item?.type ?? 'unknown');
  const params = Object.entries(item ?? {})
    .filter(([k, v]) => k !== 'type' && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return params.length ? `${type} (${params.join(', ')})` : type;
}

const stable = (i: Item) => JSON.stringify(Object.keys(i ?? {}).sort().map((k) => [k, (i as any)[k]]));

/** Differences between two item lists, as change entries ("Condition added on transition X: ..."). */
export function diffItemLists(kind: 'condition' | 'validator' | 'postFunction', label: string, transitionName: string, before: Item[], after: Item[]): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  const count = new Map<string, number>();
  for (const b of before) count.set(stable(b), (count.get(stable(b)) ?? 0) + 1);
  const added: Item[] = [];
  for (const a of after) {
    const k = stable(a);
    const n = count.get(k) ?? 0;
    if (n > 0) count.set(k, n - 1); else added.push(a);
  }
  const removed: Item[] = [];
  for (const b of before) {
    const k = stable(b);
    // whatever is left in `count` was not matched by `after`
    const n = count.get(k) ?? 0;
    if (n > 0) { removed.push(b); count.set(k, n - 1); }
  }
  for (const a of added) out.push({ targetType: kind, action: 'created', summary: `${label} added on transition "${transitionName}": ${describeItem(a)}`, details: { transition: transitionName, item: a } });
  for (const r of removed) out.push({ targetType: kind, action: 'deleted', summary: `${label} removed from transition "${transitionName}": ${describeItem(r)}`, details: { transition: transitionName, item: r } });
  return out;
}

export interface TransitionSnapshot {
  name: string;
  fromStatusId: number | null;
  toStatusId: number;
  screenId: number | null;
  conditions: Item[];
  validators: Item[];
  postFunctions: Item[];
}

/** Entries describing what changed between two versions of a transition. */
export function diffTransition(before: TransitionSnapshot, after: TransitionSnapshot, statusName: (id: number | null) => string): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`renamed from "${before.name}"`);
  if (before.fromStatusId !== after.fromStatusId) parts.push(`source ${statusName(before.fromStatusId)} -> ${statusName(after.fromStatusId)}`);
  if (before.toStatusId !== after.toStatusId) parts.push(`target ${statusName(before.toStatusId)} -> ${statusName(after.toStatusId)}`);
  if (before.screenId !== after.screenId) parts.push('screen changed');
  if (parts.length) out.push({ targetType: 'transition', action: 'updated', summary: `Transition "${after.name}" ${parts.join('; ')}`, details: { before: { name: before.name, from: before.fromStatusId, to: before.toStatusId }, after: { name: after.name, from: after.fromStatusId, to: after.toStatusId } } });
  out.push(...diffItemLists('condition', 'Condition', after.name, before.conditions, after.conditions));
  out.push(...diffItemLists('validator', 'Validator', after.name, before.validators, after.validators));
  out.push(...diffItemLists('postFunction', 'Post-function', after.name, before.postFunctions, after.postFunctions));
  return out;
}

export async function listWorkflowChanges(workflowId: number, limit = 100, offset = 0) {
  const rows = await db.select().from(schema.workflowChangeLog)
    .where(eq(schema.workflowChangeLog.workflowId, workflowId))
    .orderBy(desc(schema.workflowChangeLog.createdAt), desc(schema.workflowChangeLog.id))
    .limit(limit).offset(offset);
  const ids = [...new Set(rows.map((r) => r.actorId).filter((x): x is number => x !== null))];
  const users = ids.length ? await db.select({ id: schema.users.id, name: schema.users.displayName, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, ids)) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    actor: r.actorId ? { id: r.actorId, name: byId.get(r.actorId)?.name ?? byId.get(r.actorId)?.username ?? 'Unknown' } : null,
    targetType: r.targetType,
    action: r.action,
    summary: r.summary,
    details: r.details,
  }));
}

/** Workflows whose canvas or transitions contain the status (used to file status changes into their history). */
export async function workflowsUsingStatus(statusId: number): Promise<number[]> {
  const tr = await db.select({ w: schema.workflowTransitions.workflowId, f: schema.workflowTransitions.fromStatusId, t: schema.workflowTransitions.toStatusId }).from(schema.workflowTransitions);
  const ids = new Set(tr.filter((t) => t.f === statusId || t.t === statusId).map((t) => t.w));
  const layouts = await db.select({ id: schema.workflows.id, layout: schema.workflows.designerLayout }).from(schema.workflows);
  for (const w of layouts) if (String(statusId) in (((w.layout as any)?.nodes) ?? {})) ids.add(w.id);
  return [...ids];
}
