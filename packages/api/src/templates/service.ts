import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import type { CreateIssueRequest } from '../issues/types';
import { renderSummaryPattern } from './pattern';

export type TemplateRow = typeof schema.issueTemplates.$inferSelect;

export function serializeTemplate(t: TemplateRow, projectKey: string | null) {
  return {
    id: t.id,
    scope: t.projectId === null ? 'global' as const : 'project' as const,
    projectKey,
    name: t.name,
    description: t.description,
    issueTypeId: t.issueTypeId,
    summaryPattern: t.summaryPattern,
    body: t.body,
    priorityId: t.priorityId,
    labels: t.labels,
    components: t.componentNames,
    assigneeId: t.assigneeId,
    customFields: t.customFields,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** Component ids of the target project for the template's component names (case-insensitive; unknown names are skipped). */
export async function resolveComponentIds(projectId: number, names: string[]): Promise<number[]> {
  if (!names.length) return [];
  const rows = await db.select({ id: schema.components.id, name: schema.components.name }).from(schema.components).where(eq(schema.components.projectId, projectId));
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  return rows.filter((r) => wanted.has(r.name.toLowerCase())).map((r) => r.id);
}

/**
 * The create-issue request a template stands for in a project. `at` is the moment used for the {date} style
 * placeholders (the scheduled slot for recurring issues, now for manual use). An assignee who is no longer active is dropped.
 */
export async function buildCreateRequest(
  t: TemplateRow,
  project: { id: number; projectKey: string },
  opts: { at?: Date; timezone?: string } = {},
): Promise<CreateIssueRequest> {
  if (!t.issueTypeId) throw new Error(`Template "${t.name}" has no issue type (it was deleted); edit the template and pick one`);
  let assigneeId: number | undefined;
  if (t.assigneeId) {
    const [u] = await db.select({ active: schema.users.active }).from(schema.users).where(eq(schema.users.id, t.assigneeId)).limit(1);
    if (u?.active) assigneeId = t.assigneeId;
  }
  const components = await resolveComponentIds(project.id, t.componentNames);
  const summary = renderSummaryPattern(t.summaryPattern || t.name, { at: opts.at ?? new Date(), timezone: opts.timezone, projectKey: project.projectKey });
  return {
    projectId: project.id,
    issueTypeId: t.issueTypeId,
    summary: summary || t.name,
    description: t.body || undefined,
    priorityId: t.priorityId ?? undefined,
    assigneeId,
    labels: t.labels.length ? t.labels : undefined,
    components: components.length ? components : undefined,
    customFields: t.customFields.length ? t.customFields.map((f) => ({ fieldId: f.fieldId, value: f.value })) : undefined,
  };
}

export async function templateNameTaken(projectId: number | null, name: string, exceptId?: number): Promise<boolean> {
  const rows = await db.select({ id: schema.issueTemplates.id }).from(schema.issueTemplates)
    .where(and(projectId === null ? sql`${schema.issueTemplates.projectId} IS NULL` : eq(schema.issueTemplates.projectId, projectId), sql`lower(${schema.issueTemplates.name}) = lower(${name})`));
  return rows.some((r) => r.id !== exceptId);
}

/** Validation of the references in a template body; returns an error message or null. */
export async function checkTemplateRefs(b: { issueTypeId?: number | null; priorityId?: number | null; assigneeId?: number | null; customFields?: Array<{ fieldId: number }> }): Promise<string | null> {
  if (b.issueTypeId) {
    const [r] = await db.select({ id: schema.issueTypes.id }).from(schema.issueTypes).where(eq(schema.issueTypes.id, b.issueTypeId)).limit(1);
    if (!r) return 'Unknown issue type';
  }
  if (b.priorityId) {
    const [r] = await db.select({ id: schema.priorities.id }).from(schema.priorities).where(eq(schema.priorities.id, b.priorityId)).limit(1);
    if (!r) return 'Unknown priority';
  }
  if (b.assigneeId) {
    const [r] = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, b.assigneeId), eq(schema.users.active, true))).limit(1);
    if (!r) return 'Unknown or inactive assignee';
  }
  if (b.customFields?.length) {
    const ids = [...new Set(b.customFields.map((f) => f.fieldId))];
    const rows = await db.select({ id: schema.customFields.id }).from(schema.customFields).where(inArray(schema.customFields.id, ids));
    if (rows.length !== ids.length) return 'Unknown custom field';
  }
  return null;
}
