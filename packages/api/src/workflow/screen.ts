/** Database side of transition screens: load a screen's fields, current values and check referenced ids. */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { SYSTEM_SCREEN_FIELDS, customScreenType, type ScreenFieldDef, type ParsedScreenInput } from './screen-fields';
import type { Executor } from '../issues/service';

/** Ordered fields of a screen (tabs in order, fields in order); unknown legacy rows are skipped. */
export async function loadScreenFields(screenId: number, ex: Executor = db): Promise<ScreenFieldDef[]> {
  const tabs = await ex.select().from(schema.screenTabs).where(eq(schema.screenTabs.screenId, screenId)).orderBy(asc(schema.screenTabs.sortOrder), asc(schema.screenTabs.id));
  if (tabs.length === 0) return [];
  const rows = await ex.select().from(schema.screenTabFields).where(inArray(schema.screenTabFields.tabId, tabs.map((t) => t.id))).orderBy(asc(schema.screenTabFields.sortOrder), asc(schema.screenTabFields.id));
  const tabOrder = new Map(tabs.map((t, i) => [t.id, i]));
  rows.sort((a, b) => (tabOrder.get(a.tabId)! - tabOrder.get(b.tabId)!) || ((a.sortOrder ?? 0) - (b.sortOrder ?? 0)) || a.id - b.id);

  const customIds = rows.filter((r) => r.isCustomField).map((r) => r.fieldId);
  const customs = customIds.length ? await ex.select().from(schema.customFields).where(inArray(schema.customFields.id, customIds)) : [];
  const options = customIds.length ? await ex.select().from(schema.customFieldOptions).where(and(inArray(schema.customFieldOptions.customFieldId, customIds), eq(schema.customFieldOptions.archived, false))).orderBy(asc(schema.customFieldOptions.sortOrder), asc(schema.customFieldOptions.id)) : [];

  const out: ScreenFieldDef[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let def: ScreenFieldDef | null = null;
    if (r.isCustomField) {
      const cf = customs.find((c) => c.id === r.fieldId);
      if (cf) {
        const type = customScreenType(cf.fieldType);
        const opts = [...new Set(options.filter((o) => o.customFieldId === cf.id).map((o) => o.value))];
        def = { key: `customfield_${cf.id}`, name: cf.name, type, custom: true, customId: cf.id, required: !!r.required, ...(type === 'select' && opts.length ? { options: opts } : {}) };
      }
    } else if (r.fieldKey) {
      const sys = SYSTEM_SCREEN_FIELDS.find((f) => f.key === r.fieldKey);
      if (sys) def = { key: sys.key, name: sys.name, type: sys.type, custom: false, required: !!r.required };
    }
    if (def && !seen.has(def.key)) { seen.add(def.key); out.push(def); }
  }
  return out;
}

/** Which screen fields the issue already has a value for (a required field the request leaves out is then fine). */
export async function currentValuePresence(ex: Executor, issueId: number, defs: ScreenFieldDef[]): Promise<(key: string) => boolean> {
  const [issue] = await ex.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1);
  const has = new Set<string>();
  if (!issue) return () => false;
  if (issue.assigneeId) has.add('assignee');
  if (issue.priorityId) has.add('priority');
  if (issue.resolutionId) has.add('resolution');
  if (issue.dueDate) has.add('duedate');
  if (issue.storyPoints !== null) has.add('storyPoints');
  if (issue.environment) has.add('environment');
  const count = async (t: any, col: any) => Number((await ex.select({ n: sql<number>`count(*)::int` }).from(t).where(eq(col, issueId)))[0]?.n ?? 0);
  if (defs.some((d) => d.key === 'labels') && (await count(schema.issueLabels, schema.issueLabels.issueId)) > 0) has.add('labels');
  if (defs.some((d) => d.key === 'components') && (await count(schema.issueComponents, schema.issueComponents.issueId)) > 0) has.add('components');
  if (defs.some((d) => d.key === 'fixVersions') && (await count(schema.issueFixVersions, schema.issueFixVersions.issueId)) > 0) has.add('fixVersions');
  const customIds = defs.filter((d) => d.custom).map((d) => d.customId!);
  if (customIds.length) {
    const vals = await ex.select({ id: schema.customFieldValues.customFieldId }).from(schema.customFieldValues).where(and(eq(schema.customFieldValues.issueId, issueId), inArray(schema.customFieldValues.customFieldId, customIds)));
    for (const v of vals) has.add(`customfield_${v.id}`);
  }
  return (k) => has.has(k);
}

/** Referenced ids must exist (and components/versions must belong to the issue's project). Returns per-field errors. */
export async function checkScreenRefs(ex: Executor, projectId: number, refs: ParsedScreenInput['refs']): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (refs.assigneeId !== undefined) {
    const [u] = await ex.select({ id: schema.users.id, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, refs.assigneeId)).limit(1);
    if (!u || u.active === false) errors.assignee = 'Assignee does not exist or is deactivated';
  }
  if (refs.priorityId !== undefined) {
    const [p] = await ex.select({ id: schema.priorities.id }).from(schema.priorities).where(eq(schema.priorities.id, refs.priorityId)).limit(1);
    if (!p) errors.priority = 'Priority does not exist';
  }
  if (refs.componentIds?.length) {
    const rows = await ex.select({ id: schema.components.id }).from(schema.components).where(and(inArray(schema.components.id, refs.componentIds), eq(schema.components.projectId, projectId)));
    if (rows.length !== refs.componentIds.length) errors.components = 'A component does not exist in this project';
  }
  if (refs.versionIds?.length) {
    const rows = await ex.select({ id: schema.versions.id }).from(schema.versions).where(and(inArray(schema.versions.id, refs.versionIds), eq(schema.versions.projectId, projectId)));
    if (rows.length !== refs.versionIds.length) errors.fixVersions = 'A version does not exist in this project';
  }
  return errors;
}
