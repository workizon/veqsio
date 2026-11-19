/**
 * Move an issue to another project (Jira's "Move" wizard).
 *
 * The target project may use other issue types and another workflow, so a move is planned first and only applied when
 * nothing blocks it:
 *   - the issue type must exist in the target project's issue type scheme (otherwise pick one that does),
 *   - the current status must be part of the target workflow, else a status to map to has to be chosen,
 *   - custom field values the target project/type does not carry are appended to the description (nothing is lost),
 *   - components and versions are matched by name in the target project, the rest are removed; sprints, milestones and an
 *     epic from the old project are removed,
 *   - a security level that the target project's scheme does not have must be removed first,
 *   - sub-tasks move with their parent; a sub-task cannot be moved on its own.
 *
 * `planMove` only reads (the preview); `applyMove` runs the same plan and writes it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { getWorkflowForIssueType } from '../workflow/scheme';
import { workflowStatusIds } from '../workflow/definition';
import { baseCategory } from '../workflow/status-groups';
import { getCustomFields } from '../issues/custom-fields';
import { generateIssueKey } from '../issues/key-generator';
import { invalidateIssueKeyCache } from '../issues/service';
import { schemeOfProject, defaultLevelForProject } from '../security/issue-security';
import { appendDroppedFields, fieldCarriedBy, stringifyFieldValue, typesAllowedInProject, type DroppedField } from './change-type';

export class MoveError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message); }
}

export interface MoveInput { projectId: number; issueTypeId?: number; statusId?: number }

interface StatusOption { id: number; name: string; category: string }

export interface MovePlan {
  issueId: number;
  issueKey: string;
  from: { project: { id: number; key: string; name: string }; type: { id: number; name: string } };
  to: { project: { id: number; key: string; name: string }; type: { id: number; name: string } };
  workflow: { from: { id: number; name: string } | null; to: { id: number; name: string } | null; changed: boolean };
  status: {
    current: { id: number; name: string };
    needsMapping: boolean;
    target: { id: number; name: string } | null;
    suggestedStatusId: number | null;
    available: StatusOption[];
  };
  /** issue types the target project accepts (offered when the current type is not among them) */
  allowedTypes: Array<{ id: number; name: string }>;
  droppedFields: DroppedField[];
  removed: { components: string[]; fixVersions: string[]; affectsVersions: string[]; sprints: string[]; milestones: number; parent: string | null };
  /** names that exist in the target project and are kept */
  keptByName: { components: string[]; fixVersions: string[]; affectsVersions: string[] };
  subtasks: Array<{ key: string; summary: string; status: string; becomes: string }>;
  securityLevelId: number | null;
  newDescription: string | null;
  warnings: string[];
  blockers: string[];
  canApply: boolean;
}

/** Statuses of the workflow an issue of (project, type) uses, with the initial one. null when no workflow applies. */
async function workflowOf(projectId: number, typeId: number) {
  const [wf] = await getWorkflowForIssueType(projectId, typeId);
  if (!wf) return null;
  const transitions = await db.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, wf.id));
  const ids = workflowStatusIds(((wf.designerLayout as any)?.nodes ?? {}), transitions.map((t) => ({ name: t.name, fromStatusId: t.fromStatusId, toStatusId: t.toStatusId })));
  const rows = ids.length ? await db.select().from(schema.statuses).where(inArray(schema.statuses.id, ids)).orderBy(schema.statuses.sortOrder, schema.statuses.id) : [];
  const initialId = transitions.find((t) => t.fromStatusId === null)?.toStatusId ?? rows[0]?.id ?? null;
  return { wf, ids, rows, initialId };
}

/** Pure: the status an issue lands in. Keeps the current one when the target workflow has it. */
export function mapStatus(currentId: number, targetIds: number[], initialId: number | null, chosenId?: number): { id: number | null; needsMapping: boolean } {
  if (targetIds.length === 0 || targetIds.includes(currentId)) return { id: chosenId && targetIds.includes(chosenId) ? chosenId : currentId, needsMapping: false };
  return { id: chosenId && targetIds.includes(chosenId) ? chosenId : null, needsMapping: true };
}

export async function planMove(issueKey: string, input: MoveInput): Promise<MovePlan> {
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, issueKey)).limit(1);
  if (!issue) throw new MoveError('Issue not found', 404);
  const [fromProject] = await db.select().from(schema.projects).where(eq(schema.projects.id, issue.projectId)).limit(1);
  const [toProject] = await db.select().from(schema.projects).where(eq(schema.projects.id, input.projectId)).limit(1);
  if (!toProject) throw new MoveError('Target project not found', 404);
  if (toProject.archivedAt) throw new MoveError('The target project is archived', 409);
  const [fromType] = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, issue.issueTypeId)).limit(1);
  const [toType] = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, input.issueTypeId ?? issue.issueTypeId)).limit(1);
  if (!toType) throw new MoveError('Target issue type not found', 404);

  const warnings: string[] = [];
  const blockers: string[] = [];
  const sameProject = fromProject.id === toProject.id;
  if (sameProject) blockers.push('Choose another project. To change the type inside this project use "Change type".');
  if (issue.parentId && fromType.isSubtask) blockers.push('A sub-task moves together with its parent: open the parent issue and move that.');

  // issue type availability in the target project
  const allowedIds = await typesAllowedInProject(toProject.id);
  const allTypes = await db.select().from(schema.issueTypes).orderBy(schema.issueTypes.id);
  const allowedTypes = allTypes.filter((t) => (allowedIds ? allowedIds.has(t.id) : true) && !!t.isSubtask === !!fromType.isSubtask).map((t) => ({ id: t.id, name: t.name }));
  if (allowedIds && !allowedIds.has(toType.id)) blockers.push(`${toType.name} is not available in ${toProject.name}: choose one of its issue types.`);

  // custom fields the target does not carry
  const [allFields, contexts] = await Promise.all([db.select().from(schema.customFields), db.select().from(schema.customFieldContexts)]);
  const [cfgAssoc] = await db.select().from(schema.fieldConfigurationSchemeAssociations).where(and(
    eq(schema.fieldConfigurationSchemeAssociations.projectId, toProject.id), eq(schema.fieldConfigurationSchemeAssociations.issueTypeId, toType.id),
  )).limit(1);
  const configItems = cfgAssoc ? await db.select().from(schema.fieldConfigurationItems).where(eq(schema.fieldConfigurationItems.configId, cfgAssoc.configId)) : [];
  const carried = new Set(allFields.filter((f) => fieldCarriedBy(f, contexts, configItems, toProject.id, toType.id)).map((f) => `customfield_${f.id}`));
  const droppedFields: DroppedField[] = (await getCustomFields(issue.id))
    .filter((v) => !carried.has(v.id) && stringifyFieldValue(v.value) !== '')
    .map((v) => ({ id: v.id, name: v.name, value: stringifyFieldValue(v.value) }));
  if (droppedFields.length) warnings.push(`${droppedFields.length} custom field value(s) do not exist in ${toProject.name}; they are appended to the description.`);
  const newDescription = appendDroppedFields(issue.description, droppedFields, `${fromProject.projectKey} ${fromType.name}`, `${toProject.projectKey} ${toType.name}`);

  // workflow and status
  const [currentStatus] = await db.select().from(schema.statuses).where(eq(schema.statuses.id, issue.statusId)).limit(1);
  const oldWf = await workflowOf(fromProject.id, fromType.id);
  const newWf = await workflowOf(toProject.id, toType.id);
  const workflowChanged = (oldWf?.wf.id ?? null) !== (newWf?.wf.id ?? null);
  let target: { id: number; name: string } | null = { id: currentStatus.id, name: currentStatus.name };
  let needsMapping = false;
  let suggested: number | null = null;
  let available: StatusOption[] = [];
  if (newWf) {
    available = newWf.rows.map((s) => ({ id: s.id, name: s.name, category: s.category }));
    const m = mapStatus(issue.statusId, newWf.ids, newWf.initialId, input.statusId);
    needsMapping = m.needsMapping;
    if (input.statusId !== undefined && !newWf.ids.includes(input.statusId)) blockers.push('The chosen status is not part of the target workflow');
    if (needsMapping) {
      const same = newWf.rows.find((s) => baseCategory(s.category) === baseCategory(currentStatus.category));
      suggested = same?.id ?? newWf.initialId;
      const chosen = m.id ? newWf.rows.find((s) => s.id === m.id) : null;
      target = chosen ? { id: chosen.id, name: chosen.name } : null;
      if (!chosen && input.statusId === undefined) blockers.push(`Status "${currentStatus.name}" does not exist in the workflow of ${toProject.name} (${newWf.wf.name}): choose a status to map to.`);
      warnings.push(`The workflow changes (${oldWf?.wf.name ?? 'default'} -> ${newWf.wf.name}) and "${currentStatus.name}" is not part of it.`);
    } else if (m.id && m.id !== issue.statusId) {
      const chosen = newWf.rows.find((s) => s.id === m.id);
      if (chosen) target = { id: chosen.id, name: chosen.name };
    }
  }

  // components and versions: kept when the target project has one with the same name
  const names = async (rows: Promise<Array<{ name: string; projectId: number }>>, targetNames: Set<string>) => {
    const r = await rows; return { kept: r.filter((x) => targetNames.has(x.name.toLowerCase())).map((x) => x.name), removed: r.filter((x) => !targetNames.has(x.name.toLowerCase())).map((x) => x.name) };
  };
  const targetComponents = new Set((await db.select({ n: schema.components.name }).from(schema.components).where(eq(schema.components.projectId, toProject.id))).map((c) => c.n.toLowerCase()));
  const targetVersions = new Set((await db.select({ n: schema.versions.name }).from(schema.versions).where(eq(schema.versions.projectId, toProject.id))).map((c) => c.n.toLowerCase()));
  const compRows = db.select({ name: schema.components.name, projectId: schema.components.projectId }).from(schema.issueComponents).innerJoin(schema.components, eq(schema.components.id, schema.issueComponents.componentId)).where(eq(schema.issueComponents.issueId, issue.id));
  const fixRows = db.select({ name: schema.versions.name, projectId: schema.versions.projectId }).from(schema.issueFixVersions).innerJoin(schema.versions, eq(schema.versions.id, schema.issueFixVersions.versionId)).where(eq(schema.issueFixVersions.issueId, issue.id));
  const affRows = db.select({ name: schema.versions.name, projectId: schema.versions.projectId }).from(schema.issueAffectsVersions).innerJoin(schema.versions, eq(schema.versions.id, schema.issueAffectsVersions.versionId)).where(eq(schema.issueAffectsVersions.issueId, issue.id));
  const [comp, fix, aff] = await Promise.all([names(compRows, targetComponents), names(fixRows, targetVersions), names(affRows, targetVersions)]);
  if (comp.removed.length || fix.removed.length || aff.removed.length) warnings.push('Components and versions that the target project does not have (by name) are removed from the issue.');

  const sprintRows = await db.select({ name: schema.sprints.name }).from(schema.sprintIssues).innerJoin(schema.sprints, eq(schema.sprints.id, schema.sprintIssues.sprintId)).where(eq(schema.sprintIssues.issueId, issue.id));
  const milestoneCount = (await db.select({ id: schema.milestoneIssues.issueId }).from(schema.milestoneIssues).where(eq(schema.milestoneIssues.issueId, issue.id))).length;
  let parentRemoved: string | null = null;
  if (issue.parentId && !fromType.isSubtask) {
    const [p] = await db.select({ key: schema.issues.issueKey }).from(schema.issues).where(eq(schema.issues.id, issue.parentId)).limit(1);
    parentRemoved = p?.key ?? null;
    if (parentRemoved) warnings.push(`The link to ${parentRemoved} (epic or parent) is removed because it is in another project.`);
  }
  if (sprintRows.length) warnings.push('The issue leaves its sprint(s) because sprints belong to the boards of one project.');

  // security level
  let securityLevelId: number | null = issue.securityLevelId ?? null;
  if (!sameProject) {
    if (issue.securityLevelId === null) securityLevelId = await defaultLevelForProject(toProject.id);
    else {
      const [lvl] = await db.select({ schemeId: schema.issueSecurityLevels.schemeId }).from(schema.issueSecurityLevels).where(eq(schema.issueSecurityLevels.id, issue.securityLevelId)).limit(1);
      const targetScheme = await schemeOfProject(toProject.id);
      if (lvl && targetScheme && targetScheme.id === lvl.schemeId) securityLevelId = issue.securityLevelId;
      else if (targetScheme?.defaultLevelId != null) { securityLevelId = targetScheme.defaultLevelId; warnings.push('The security level does not exist in the target project; its default level is used.'); }
      else blockers.push('The issue has a security level that does not exist in the target project. Remove the level first.');
    }
  }

  // sub-tasks move along
  const subs = await db.select().from(schema.issues).where(eq(schema.issues.parentId, issue.id));
  const subtasks: MovePlan['subtasks'] = [];
  for (const s of subs) {
    const [st] = await db.select().from(schema.statuses).where(eq(schema.statuses.id, s.statusId)).limit(1);
    const wf = await workflowOf(toProject.id, s.issueTypeId);
    const kept = !wf || wf.ids.includes(s.statusId);
    const becomes = kept ? st.name : (wf!.rows.find((r) => r.id === wf!.initialId)?.name ?? st.name);
    if (allowedIds && !allowedIds.has(s.issueTypeId)) blockers.push(`The sub-task ${s.issueKey} has a type that ${toProject.name} does not offer.`);
    subtasks.push({ key: s.issueKey, summary: s.summary, status: st.name, becomes });
  }
  if (subtasks.length) warnings.push(`${subtasks.length} sub-task(s) move with the issue${subtasks.some((x) => x.status !== x.becomes) ? '; those whose status is not in their new workflow start in its initial status' : ''}.`);

  return {
    issueId: issue.id, issueKey: issue.issueKey,
    from: { project: { id: fromProject.id, key: fromProject.projectKey, name: fromProject.name }, type: { id: fromType.id, name: fromType.name } },
    to: { project: { id: toProject.id, key: toProject.projectKey, name: toProject.name }, type: { id: toType.id, name: toType.name } },
    workflow: { from: oldWf ? { id: oldWf.wf.id, name: oldWf.wf.name } : null, to: newWf ? { id: newWf.wf.id, name: newWf.wf.name } : null, changed: workflowChanged },
    status: { current: { id: currentStatus.id, name: currentStatus.name }, needsMapping, target, suggestedStatusId: suggested, available },
    allowedTypes, droppedFields,
    removed: { components: comp.removed, fixVersions: fix.removed, affectsVersions: aff.removed, sprints: sprintRows.map((s) => s.name), milestones: milestoneCount, parent: parentRemoved },
    keptByName: { components: comp.kept, fixVersions: fix.kept, affectsVersions: aff.kept },
    subtasks, securityLevelId, newDescription, warnings, blockers, canApply: blockers.length === 0,
  };
}

export async function applyMove(issueKey: string, input: MoveInput, userId: number): Promise<{ plan: MovePlan; newKey: string }> {
  const plan = await planMove(issueKey, input);
  if (!plan.canApply) throw new MoveError(plan.blockers[0], 409);
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, issueKey)).limit(1);
  const newKey = await generateIssueKey(plan.to.project.id, plan.to.project.key);
  const subs = await db.select().from(schema.issues).where(eq(schema.issues.parentId, issue.id));
  const subKeys = new Map<number, string>();
  for (const s of subs) subKeys.set(s.id, await generateIssueKey(plan.to.project.id, plan.to.project.key));
  const targetProjectId = plan.to.project.id;
  const byName = async <T extends { id: number; name: string }>(rows: Promise<T[]>) => new Map((await rows).map((r) => [r.name.toLowerCase(), r.id]));
  const targetComponents = await byName(db.select({ id: schema.components.id, name: schema.components.name }).from(schema.components).where(eq(schema.components.projectId, targetProjectId)));
  const targetVersions = await byName(db.select({ id: schema.versions.id, name: schema.versions.name }).from(schema.versions).where(eq(schema.versions.projectId, targetProjectId)));

  await db.transaction(async (tx) => {
    const history: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [
      { field: 'project', oldValue: `${plan.from.project.key}:${plan.from.project.name}`, newValue: `${plan.to.project.key}:${plan.to.project.name}` },
      { field: 'key', oldValue: issue.issueKey, newValue: newKey },
    ];
    const set: Partial<typeof schema.issues.$inferInsert> = {
      projectId: targetProjectId, issueKey: newKey, issueTypeId: plan.to.type.id, securityLevelId: plan.securityLevelId, updatedAt: new Date(),
    };
    if (plan.from.type.id !== plan.to.type.id) history.push({ field: 'issuetype', oldValue: plan.from.type.name, newValue: plan.to.type.name });
    if (plan.status.target && plan.status.target.id !== issue.statusId) {
      set.statusId = plan.status.target.id;
      history.push({ field: 'status', oldValue: plan.status.current.name, newValue: plan.status.target.name });
    }
    if (plan.removed.parent) { set.parentId = null; history.push({ field: 'parent', oldValue: plan.removed.parent, newValue: null }); }
    if (plan.droppedFields.length) {
      set.description = plan.newDescription;
      history.push({ field: 'description', oldValue: issue.description || null, newValue: plan.newDescription || null });
      for (const d of plan.droppedFields) history.push({ field: d.id, oldValue: d.value, newValue: null });
      await tx.delete(schema.customFieldValues).where(and(eq(schema.customFieldValues.issueId, issue.id), inArray(schema.customFieldValues.customFieldId, plan.droppedFields.map((d) => Number(d.id.replace('customfield_', ''))))));
    }
    await tx.update(schema.issues).set(set).where(eq(schema.issues.id, issue.id));

    // components and versions re-linked by name, the rest dropped
    const relink = async (table: any, col: any, idCol: any, ids: Map<string, number>, oldNames: Array<{ id: number; name: string }>) => {
      await tx.delete(table).where(eq(table.issueId, issue.id));
      const rows = oldNames.map((o) => ids.get(o.name.toLowerCase())).filter((v): v is number => !!v);
      if (rows.length) await tx.insert(table).values(rows.map((id) => ({ issueId: issue.id, [col]: id })));
    };
    const oldComp = await tx.select({ id: schema.components.id, name: schema.components.name }).from(schema.issueComponents).innerJoin(schema.components, eq(schema.components.id, schema.issueComponents.componentId)).where(eq(schema.issueComponents.issueId, issue.id));
    await relink(schema.issueComponents, 'componentId', null, targetComponents, oldComp);
    const oldFix = await tx.select({ id: schema.versions.id, name: schema.versions.name }).from(schema.issueFixVersions).innerJoin(schema.versions, eq(schema.versions.id, schema.issueFixVersions.versionId)).where(eq(schema.issueFixVersions.issueId, issue.id));
    await relink(schema.issueFixVersions, 'versionId', null, targetVersions, oldFix);
    const oldAff = await tx.select({ id: schema.versions.id, name: schema.versions.name }).from(schema.issueAffectsVersions).innerJoin(schema.versions, eq(schema.versions.id, schema.issueAffectsVersions.versionId)).where(eq(schema.issueAffectsVersions.issueId, issue.id));
    await relink(schema.issueAffectsVersions, 'versionId', null, targetVersions, oldAff);
    await tx.delete(schema.sprintIssues).where(eq(schema.sprintIssues.issueId, issue.id));
    await tx.delete(schema.milestoneIssues).where(eq(schema.milestoneIssues.issueId, issue.id));
    await tx.insert(schema.issueHistory).values(history.map((h) => ({ issueId: issue.id, fieldName: h.field, oldValue: h.oldValue, newValue: h.newValue, authorId: userId })));

    // sub-tasks follow their parent
    for (const s of subs) {
      const wf = await workflowOf(targetProjectId, s.issueTypeId);
      const keep = !wf || wf.ids.includes(s.statusId);
      const subSet: Partial<typeof schema.issues.$inferInsert> = { projectId: targetProjectId, issueKey: subKeys.get(s.id)!, securityLevelId: plan.securityLevelId, updatedAt: new Date() };
      if (!keep && wf?.initialId) subSet.statusId = wf.initialId;
      await tx.update(schema.issues).set(subSet).where(eq(schema.issues.id, s.id));
      await tx.delete(schema.sprintIssues).where(eq(schema.sprintIssues.issueId, s.id));
      await tx.insert(schema.issueHistory).values({ issueId: s.id, fieldName: 'project', oldValue: `${plan.from.project.key}:${plan.from.project.name}`, newValue: `${plan.to.project.key}:${plan.to.project.name}`, authorId: userId });
    }
  });
  await invalidateIssueKeyCache(issue.issueKey);
  await invalidateIssueKeyCache(newKey);
  return { plan, newKey };
}
