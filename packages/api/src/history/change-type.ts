/**
 * Work item type switch: change an issue to another type of the same project.
 *
 *   - custom field values the new type's field configuration does not carry are removed and appended to the
 *     description as a labelled block with a warning (nothing is lost silently),
 *   - the new type may use another workflow: when the current status does not exist there, a mapped status must be chosen,
 *   - sub-task <-> standard type rules (a sub-task needs a parent, a parent cannot become a sub-task, a sub-task leaves its parent).
 *
 * `planTypeChange` only reads (preview); `applyTypeChange` runs the same plan and writes it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { getWorkflowForIssueType } from '../workflow/scheme';
import { workflowStatusIds } from '../workflow/definition';
import { baseCategory } from '../workflow/status-groups';
import { getCustomFields } from '../issues/custom-fields';
import { invalidateIssueKeyCache } from '../issues/service';

export class TypeChangeError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message); }
}

export interface DroppedField { id: string; name: string; value: string }

export interface TypeChangeInput {
  issueTypeId: number;
  /** status to use when the current status is not part of the new type's workflow */
  statusId?: number;
  /** parent for a standard issue that becomes a sub-task (key or id) */
  parentKey?: string;
}

export interface TypeChangePlan {
  issueId: number;
  issueKey: string;
  from: { id: number; name: string; subtask: boolean };
  to: { id: number; name: string; subtask: boolean };
  droppedFields: DroppedField[];
  workflow: { id: number | null; name: string | null; changed: boolean };
  status: {
    current: { id: number; name: string };
    /** true when the current status is not part of the new workflow */
    needsMapping: boolean;
    target: { id: number; name: string } | null;
    suggestedStatusId: number | null;
    available: Array<{ id: number; name: string; category: string }>;
  };
  parent: { current: string | null; after: string | null; parentId: number | null; cleared: boolean; required: boolean };
  /** the description after the change (with the labelled block of dropped fields) */
  newDescription: string | null;
  warnings: string[];
  /** reasons the change cannot be applied yet */
  blockers: string[];
  canApply: boolean;
}

/** Pure: does a custom field apply to (project, type)? Contexts restrict it, a field configuration can hide it. */
export function fieldCarriedBy(
  field: { id: number },
  contexts: Array<{ customFieldId: number; projectId: number | null; issueTypeId: number | null }>,
  configItems: Array<{ fieldId: number; isCustomField: boolean | null; isVisible: boolean | null }>,
  projectId: number,
  issueTypeId: number,
): boolean {
  const own = contexts.filter((c) => c.customFieldId === field.id);
  if (own.length > 0 && !own.some((c) => (c.projectId === null || c.projectId === projectId) && (c.issueTypeId === null || c.issueTypeId === issueTypeId))) {
    return false;
  }
  const item = configItems.find((i) => i.isCustomField && i.fieldId === field.id);
  if (item && item.isVisible === false) return false;
  return true;
}

export function stringifyFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Pure: appends the labelled warning block to the description. */
export function appendDroppedFields(description: string | null, dropped: DroppedField[], fromType: string, toType: string, date = new Date()): string | null {
  if (dropped.length === 0) return description;
  const lines = [
    '---',
    `**Warning: fields removed by the type change ${fromType} -> ${toType} (${date.toISOString().slice(0, 10)})**`,
    `The ${toType} type does not carry these fields. Their values were moved here so nothing is lost:`,
    '',
    ...dropped.map((d) => `- **${d.name}:** ${d.value.replace(/\r?\n/g, ' ')}`),
  ];
  return `${description ? `${description.replace(/\s+$/, '')}\n\n` : ''}${lines.join('\n')}`;
}

async function loadIssue(idOrKey: string) {
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, idOrKey)).limit(1);
  return issue ?? null;
}

export async function typesAllowedInProject(projectId: number): Promise<Set<number> | null> {
  const [assoc] = await db.select().from(schema.issueTypeSchemeAssociations).where(eq(schema.issueTypeSchemeAssociations.projectId, projectId)).limit(1);
  if (!assoc) return null;
  const items = await db.select().from(schema.issueTypeSchemeItems).where(eq(schema.issueTypeSchemeItems.schemeId, assoc.schemeId));
  return new Set(items.map((i) => i.issueTypeId));
}

export async function planTypeChange(issueKey: string, input: TypeChangeInput): Promise<TypeChangePlan> {
  const issue = await loadIssue(issueKey);
  if (!issue) throw new TypeChangeError('Issue not found', 404);
  const [fromType] = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, issue.issueTypeId)).limit(1);
  const [toType] = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, input.issueTypeId)).limit(1);
  if (!toType) throw new TypeChangeError('Target issue type not found', 404);
  if (toType.id === issue.issueTypeId) throw new TypeChangeError('The issue already has this type');

  const warnings: string[] = [];
  const blockers: string[] = [];

  const allowed = await typesAllowedInProject(issue.projectId);
  if (allowed && !allowed.has(toType.id)) blockers.push(`${toType.name} is not available in this project's issue type scheme`);

  // Custom fields the new type does not carry
  const [allFields, contexts] = await Promise.all([
    db.select().from(schema.customFields),
    db.select().from(schema.customFieldContexts),
  ]);
  const [cfgAssoc] = await db.select().from(schema.fieldConfigurationSchemeAssociations).where(and(
    eq(schema.fieldConfigurationSchemeAssociations.projectId, issue.projectId),
    eq(schema.fieldConfigurationSchemeAssociations.issueTypeId, toType.id),
  )).limit(1);
  const configItems = cfgAssoc ? await db.select().from(schema.fieldConfigurationItems).where(eq(schema.fieldConfigurationItems.configId, cfgAssoc.configId)) : [];
  const carried = new Set(allFields.filter((f) => fieldCarriedBy(f, contexts, configItems, issue.projectId, toType.id)).map((f) => `customfield_${f.id}`));
  const values = await getCustomFields(issue.id);
  const droppedFields: DroppedField[] = values
    .filter((v) => !carried.has(v.id) && stringifyFieldValue(v.value) !== '')
    .map((v) => ({ id: v.id, name: v.name, value: stringifyFieldValue(v.value) }));
  if (droppedFields.length) warnings.push(`${droppedFields.length} custom field value(s) are not available for ${toType.name}; they are appended to the description.`);
  const newDescription = appendDroppedFields(issue.description, droppedFields, fromType.name, toType.name);

  // Workflow and status
  const [currentStatus] = await db.select().from(schema.statuses).where(eq(schema.statuses.id, issue.statusId)).limit(1);
  const [oldWf] = await getWorkflowForIssueType(issue.projectId, issue.issueTypeId);
  const [newWf] = await getWorkflowForIssueType(issue.projectId, toType.id);
  const workflowChanged = (oldWf?.id ?? null) !== (newWf?.id ?? null);
  let available: Array<{ id: number; name: string; category: string }> = [];
  let needsMapping = false;
  let target: { id: number; name: string } | null = { id: currentStatus.id, name: currentStatus.name };
  let suggested: number | null = null;
  if (newWf) {
    const transitions = await db.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, newWf.id));
    const ids = workflowStatusIds(((newWf.designerLayout as any)?.nodes ?? {}), transitions.map((t) => ({ name: t.name, fromStatusId: t.fromStatusId, toStatusId: t.toStatusId })));
    if (ids.length > 0) {
      const rows = await db.select().from(schema.statuses).where(inArray(schema.statuses.id, ids)).orderBy(schema.statuses.sortOrder, schema.statuses.id);
      available = rows.map((s) => ({ id: s.id, name: s.name, category: s.category }));
      if (!ids.includes(issue.statusId)) {
        needsMapping = true;
        // Prefer a status of the same category, otherwise the initial status of the new workflow.
        const sameCategory = rows.find((s) => baseCategory(s.category) === baseCategory(currentStatus.category));
        const initial = transitions.find((t) => t.fromStatusId === null);
        suggested = sameCategory?.id ?? initial?.toStatusId ?? rows[0]?.id ?? null;
        target = null;
        if (input.statusId !== undefined) {
          const chosen = rows.find((s) => s.id === input.statusId);
          if (!chosen) blockers.push('The chosen status is not part of the workflow of the new type');
          else target = { id: chosen.id, name: chosen.name };
        } else {
          blockers.push(`Status "${currentStatus.name}" does not exist in the workflow of ${toType.name}: choose a status to map to`);
        }
        warnings.push(`The workflow changes (${oldWf?.name ?? 'default'} -> ${newWf.name}) and "${currentStatus.name}" is not part of it.`);
      } else if (input.statusId !== undefined && input.statusId !== issue.statusId) {
        // Optional: the user may also move to another status of the new workflow.
        const chosen = rows.find((s) => s.id === input.statusId);
        if (!chosen) blockers.push('The chosen status is not part of the workflow of the new type');
        else target = { id: chosen.id, name: chosen.name };
      }
    }
  }

  // Sub-task <-> standard rules
  const fromSub = !!fromType.isSubtask, toSub = !!toType.isSubtask;
  const subtaskCount = (await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.parentId, issue.id))).length;
  let parentId: number | null = issue.parentId ?? null;
  let parentKeyBefore: string | null = null;
  if (issue.parentId) {
    const [p] = await db.select({ key: schema.issues.issueKey }).from(schema.issues).where(eq(schema.issues.id, issue.parentId)).limit(1);
    parentKeyBefore = p?.key ?? null;
  }
  let parentKeyAfter = parentKeyBefore;
  let cleared = false;
  let required = false;
  if (!fromSub && toSub) {
    if (subtaskCount > 0) blockers.push(`${issueKey} has ${subtaskCount} sub-task(s) and cannot become a sub-task itself`);
    if (input.parentKey) {
      const [p] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, input.parentKey.toUpperCase())).limit(1);
      if (!p) blockers.push(`Parent ${input.parentKey} not found`);
      else {
        const [pt] = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, p.issueTypeId)).limit(1);
        if (p.projectId !== issue.projectId) blockers.push('The parent must be in the same project');
        else if (p.id === issue.id) blockers.push('An issue cannot be its own parent');
        else if (pt?.isSubtask) blockers.push('The parent cannot be a sub-task');
        else { parentId = p.id; parentKeyAfter = p.issueKey; }
      }
    } else if (!issue.parentId) {
      required = true;
      blockers.push(`${toType.name} is a sub-task type: choose a parent issue (parentKey)`);
    } else {
      warnings.push(`The existing parent ${parentKeyBefore} becomes the parent of the sub-task.`);
    }
  } else if (fromSub && !toSub) {
    if (issue.parentId) {
      cleared = true;
      parentId = null;
      parentKeyAfter = null;
      warnings.push(`The issue leaves its parent ${parentKeyBefore} and becomes a standard issue.`);
    }
  }

  const canApply = blockers.length === 0;
  return {
    issueId: issue.id, issueKey: issue.issueKey,
    from: { id: fromType.id, name: fromType.name, subtask: fromSub },
    to: { id: toType.id, name: toType.name, subtask: toSub },
    droppedFields,
    workflow: { id: newWf?.id ?? null, name: newWf?.name ?? null, changed: workflowChanged },
    status: { current: { id: currentStatus.id, name: currentStatus.name }, needsMapping, target, suggestedStatusId: suggested, available },
    parent: { current: parentKeyBefore, after: parentKeyAfter, parentId, cleared, required },
    newDescription, warnings, blockers, canApply,
  };
}

export async function applyTypeChange(issueKey: string, input: TypeChangeInput, userId: number): Promise<TypeChangePlan> {
  const plan = await planTypeChange(issueKey, input);
  if (!plan.canApply) throw new TypeChangeError(plan.blockers[0], 409);
  const issue = (await loadIssue(issueKey))!;
  const history: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [
    { field: 'issuetype', oldValue: plan.from.name, newValue: plan.to.name },
  ];
  const set: Partial<typeof schema.issues.$inferInsert> = { issueTypeId: plan.to.id, updatedAt: new Date() };
  if (plan.status.target && plan.status.target.id !== issue.statusId) {
    set.statusId = plan.status.target.id;
    history.push({ field: 'status', oldValue: plan.status.current.name, newValue: plan.status.target.name });
  }
  if (plan.parent.parentId !== (issue.parentId ?? null)) {
    set.parentId = plan.parent.parentId;
    history.push({ field: 'parent', oldValue: plan.parent.current, newValue: plan.parent.after });
  }
  if (plan.droppedFields.length) {
    set.description = plan.newDescription;
    history.push({ field: 'description', oldValue: issue.description || null, newValue: plan.newDescription || null });
    for (const d of plan.droppedFields) history.push({ field: d.id, oldValue: d.value, newValue: null });
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.issues).set(set).where(eq(schema.issues.id, issue.id));
    if (plan.droppedFields.length) {
      const fieldIds = plan.droppedFields.map((d) => Number(d.id.replace('customfield_', '')));
      await tx.delete(schema.customFieldValues).where(and(eq(schema.customFieldValues.issueId, issue.id), inArray(schema.customFieldValues.customFieldId, fieldIds)));
    }
    await tx.insert(schema.issueHistory).values(history.map((h) => ({ issueId: issue.id, fieldName: h.field, oldValue: h.oldValue, newValue: h.newValue, authorId: userId })));
  });
  await invalidateIssueKeyCache(issue.issueKey);
  return plan;
}
