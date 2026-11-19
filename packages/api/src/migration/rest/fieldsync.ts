import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import { mapFieldType, type FieldBinding, type JiraFieldMeta, type VeqsioFieldType } from './customfields'
import { planFields, type FieldOverride, type FieldPlanRow } from './fieldmap'
import { fetchCreateMeta, fetchFieldMeta, requiredFromCreateMeta, type FieldMeta, type JiraContextMeta, type JiraOption } from './fieldmeta'
import type { JiraClient } from './client'

/** Source name under which the Jira ids of custom fields are remembered in migration_external_refs. */
export const JIRA_SOURCE = 'jira'
export const FIELD_ENTITY = 'customfield'

export interface FieldReport {
  created: Array<{ jiraId: string; jiraName: string; name: string; type: string; note?: string }>
  matched: Array<{ jiraId: string; jiraName: string; name: string; by: 'id' | 'name'; note?: string }>
  skipped: Array<{ jiraId: string; jiraName: string; reason: string }>
  contexts: number
  options: number
  /** (project, issue type) pairs that got a field configuration with required custom fields. */
  requiredConfigs?: number
}

export async function loadFieldRefs(): Promise<Map<string, number>> {
  const rows = await db.select().from(schema.migrationExternalRefs)
    .where(and(eq(schema.migrationExternalRefs.source, JIRA_SOURCE), eq(schema.migrationExternalRefs.entityType, FIELD_ENTITY)))
  return new Map(rows.map((r) => [r.externalId, r.localId]))
}

/** The plan for the preview and for the import: the same function with the same inputs gives the same decisions. */
export async function planFromDb(jira: JiraFieldMeta[], overrides: Record<string, FieldOverride> = {}): Promise<FieldPlanRow[]> {
  const existing = await db.select({ id: schema.customFields.id, name: schema.customFields.name, fieldType: schema.customFields.fieldType }).from(schema.customFields)
  return planFields(jira, existing, await loadFieldRefs(), overrides)
}

async function remember(jiraId: string, jiraName: string, localId: number): Promise<void> {
  await db.insert(schema.migrationExternalRefs)
    .values({ source: JIRA_SOURCE, entityType: FIELD_ENTITY, externalId: jiraId, externalKey: jiraName.slice(0, 255), localId })
    .onConflictDoUpdate({
      target: [schema.migrationExternalRefs.source, schema.migrationExternalRefs.entityType, schema.migrationExternalRefs.externalId],
      set: { localId, externalKey: jiraName.slice(0, 255), updatedAt: new Date() },
    })
}

export interface FieldSyncResult { bindings: FieldBinding[]; report: FieldReport; /** local ids of the fields created in this run */ createdIds: Set<number> }

/** Creates or finds the Veqsio fields for the Jira fields, remembers the Jira id of each, and reports every decision. */
export async function syncCustomFields(jira: JiraFieldMeta[], warnings: string[], overrides: Record<string, FieldOverride> = {}): Promise<FieldSyncResult> {
  const plan = await planFromDb(jira, overrides)
  const report: FieldReport = { created: [], matched: [], skipped: [], contexts: 0, options: 0 }
  const bindings: FieldBinding[] = []
  const createdIds = new Set<number>()
  for (const row of plan) {
    if (row.action === 'skip' || !row.ourType) {
      // built-in and plumbing fields are not worth a line each; the fields a person would look for are
      if (row.jiraId.startsWith('customfield_')) report.skipped.push({ jiraId: row.jiraId, jiraName: row.jiraName, reason: row.reason ?? 'not supported' })
      continue
    }
    let localId = row.localId
    if (row.action === 'create') {
      const [r] = await db.insert(schema.customFields).values({
        name: row.localName, fieldType: row.ourType, isGlobal: true, description: `Imported from Jira (${row.jiraId})`,
      }).returning({ id: schema.customFields.id })
      localId = r.id
      createdIds.add(r.id)
      report.created.push({ jiraId: row.jiraId, jiraName: row.jiraName, name: row.localName, type: row.ourType, ...(row.reason ? { note: row.reason } : {}) })
    } else {
      report.matched.push({ jiraId: row.jiraId, jiraName: row.jiraName, name: row.localName, by: row.action === 'match-id' ? 'id' : 'name', ...(row.reason ? { note: row.reason } : {}) })
      if (row.reason) warnings.push(`Custom field "${row.jiraName}" → "${row.localName}": ${row.reason}`)
    }
    await remember(row.jiraId, row.jiraName, localId!)
    bindings.push({ jiraId: row.jiraId, veqsioId: localId!, type: row.ourType as VeqsioFieldType, name: row.localName })
  }
  return { bindings, report, createdIds }
}

const MAX_CONTEXT_ROWS = 60
const label = (o: JiraOption) => (o.parent ? `${o.parent} / ${o.value}` : o.value)

/** Option labels of a context in display order: a cascading parent comes before its children, each as it is shown on an issue ("A / B"). */
export function optionLabels(options: JiraOption[]): Array<{ value: string; archived: boolean }> {
  const seen = new Set<string>()
  const out: Array<{ value: string; archived: boolean }> = []
  const parents = options.filter((o) => !o.parent)
  const add = (o: JiraOption) => { const v = label(o).slice(0, 255); if (!seen.has(v)) { seen.add(v); out.push({ value: v, archived: !!o.disabled }) } }
  for (const p of parents) { add(p); for (const ch of options.filter((o) => o.parent === p.value)) add(ch) }
  for (const o of options.filter((o) => o.parent && !parents.some((p) => p.value === o.parent))) add(o)
  return out
}

/**
 * Writes contexts, list options and the default value of the fields. Runs after the issues, because the projects and issue types it
 * refers to exist by then. A field that was created in this run gets the contexts of Jira. A field that already existed keeps its
 * contexts; only the options it lacks are added, to its first context (or to a new global one when it has none).
 */
export async function applyFieldMeta(
  bindings: FieldBinding[], createdIds: Set<number>, metas: Map<string, FieldMeta>, report: FieldReport, warnings: string[],
): Promise<void> {
  if (bindings.length === 0 || metas.size === 0) return
  const projects = await db.select({ id: schema.projects.id, key: schema.projects.projectKey }).from(schema.projects)
  const projectByKey = new Map(projects.map((p) => [p.key, p.id]))
  const types = await db.select({ id: schema.issueTypes.id, name: schema.issueTypes.name }).from(schema.issueTypes)
  const typeByName = new Map(types.map((t) => [t.name.toLowerCase(), t.id]))

  for (const b of bindings) {
    const meta = metas.get(b.jiraId)
    if (!meta) continue
    const isList = b.type === 'select' || b.type === 'multiselect'
    const fresh = createdIds.has(b.veqsioId)
    let defaultValue: string | undefined

    if (fresh) {
      let rows = 0
      let unresolved = 0
      for (const ctx of meta.contexts) {
        const pairs = contextPairs(ctx, projectByKey, typeByName)
        if (pairs === 'unresolvable') { unresolved++; continue }
        for (const [projectId, issueTypeId] of pairs.slice(0, Math.max(0, MAX_CONTEXT_ROWS - rows))) {
          const [row] = await db.insert(schema.customFieldContexts).values({ customFieldId: b.veqsioId, projectId, issueTypeId, defaultValue: ctx.defaultValue ?? null }).returning({ id: schema.customFieldContexts.id })
          rows++
          report.contexts++
          if (isList) report.options += await insertOptions(b.veqsioId, row.id, ctx.options)
        }
        if (ctx.defaultValue && !defaultValue) defaultValue = ctx.defaultValue
        if (pairs.length > MAX_CONTEXT_ROWS) warnings.push(`Custom field "${b.name}": the Jira contexts span more projects and issue types than are imported here; only the first ${MAX_CONTEXT_ROWS} combinations were created`)
      }
      if (rows === 0 && meta.contexts.length > 0) {
        // the field exists for projects that are not imported; with no context it shows everywhere, which is the safer way to be wrong
        if (unresolved) warnings.push(`Custom field "${b.name}" is limited in Jira to projects or issue types that are not imported here; it is available everywhere until you restrict it`)
        if (isList) {
          const all = meta.contexts.flatMap((c) => c.options)
          if (all.length) {
            const [g] = await db.insert(schema.customFieldContexts).values({ customFieldId: b.veqsioId, projectId: null, issueTypeId: null }).returning({ id: schema.customFieldContexts.id })
            report.contexts++
            report.options += await insertOptions(b.veqsioId, g.id, all)
          }
        }
      }
    } else if (isList) {
      // an existing list field: add what it lacks
      const wanted = meta.contexts.flatMap((c) => c.options)
      if (wanted.length) {
        let [ctxRow] = await db.select({ id: schema.customFieldContexts.id }).from(schema.customFieldContexts).where(eq(schema.customFieldContexts.customFieldId, b.veqsioId)).orderBy(schema.customFieldContexts.id).limit(1)
        if (!ctxRow) [ctxRow] = await db.insert(schema.customFieldContexts).values({ customFieldId: b.veqsioId, projectId: null, issueTypeId: null }).returning({ id: schema.customFieldContexts.id })
        const have = await db.select({ value: schema.customFieldOptions.value }).from(schema.customFieldOptions).where(eq(schema.customFieldOptions.customFieldId, b.veqsioId))
        const haveSet = new Set(have.map((h) => h.value.toLowerCase()))
        report.options += await insertOptions(b.veqsioId, ctxRow.id, wanted.filter((o) => !haveSet.has(label(o).toLowerCase())))
      }
    }

    if (defaultValue) {
      await db.update(schema.customFields).set({ defaultValue }).where(and(eq(schema.customFields.id, b.veqsioId), sql`${schema.customFields.defaultValue} IS NULL`))
    }
  }
}

/** The (project, issue type) pairs a Jira context becomes; 'unresolvable' when it is limited to projects or types that are not here. */
export function contextPairs(ctx: JiraContextMeta, projectByKey: Map<string, number>, typeByName: Map<string, number>): Array<[number | null, number | null]> | 'unresolvable' {
  if (ctx.global) return [[null, null]]
  const projectIds = ctx.projectKeys.length ? ctx.projectKeys.map((k) => projectByKey.get(k)).filter((x): x is number => x !== undefined) : [null]
  if (ctx.projectKeys.length && projectIds.length === 0) return 'unresolvable'
  const typeIds = ctx.issueTypeNames === null ? [null] : ctx.issueTypeNames.map((n) => typeByName.get(n.toLowerCase())).filter((x): x is number => x !== undefined)
  if (ctx.issueTypeNames !== null && typeIds.length === 0) return 'unresolvable'
  const out: Array<[number | null, number | null]> = []
  for (const p of projectIds) for (const t of typeIds) out.push([p, t])
  return out
}

async function insertOptions(fieldId: number, contextId: number, options: JiraOption[]): Promise<number> {
  const labels = optionLabels(options)
  if (labels.length === 0) return 0
  await db.insert(schema.customFieldOptions).values(labels.map((o, i) => ({ customFieldId: fieldId, contextId, value: o.value, sortOrder: i, archived: o.archived })))
  return labels.length
}

/** Reads the contexts of the bound fields from Jira. */
export async function readFieldMeta(client: Pick<JiraClient, 'get'>, bindings: FieldBinding[], projectKeys: string[], warnings: string[]): Promise<Map<string, FieldMeta>> {
  return fetchFieldMeta(client, bindings.map((b) => b.jiraId), projectKeys, warnings)
}

/** A short, stable name part for a set of field ids: the same set of required fields is one field configuration. */
export function requiredSetName(names: string[]): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const shown = sorted.slice(0, 3).join(', ')
  return `Jira: required ${shown}${sorted.length > 3 ? ` and ${sorted.length - 3} more` : ''}`.slice(0, 250)
}

/**
 * The fields Jira requires when an issue is created, per project and issue type (from create metadata, which both Cloud and Data
 * Center answer): one field configuration per distinct set of required custom fields, assigned to the project and issue type pairs
 * that have it. A pair that already has a field configuration is left alone.
 */
export async function importRequiredFlags(
  client: Pick<JiraClient, 'get'>, bindings: FieldBinding[], importedProjects: Array<{ id: number; key: string }>, report: FieldReport, warnings: string[],
): Promise<void> {
  if (bindings.length === 0 || importedProjects.length === 0) return
  let meta
  try { meta = await fetchCreateMeta(client, importedProjects.map((p) => p.key)) } catch (e: any) {
    warnings.push(`Required fields not imported: the create metadata could not be read (${String(e?.message ?? e).slice(0, 100)})`)
    return
  }
  const required = requiredFromCreateMeta(bindings.map((b) => b.jiraId), meta)
  if (required.size === 0) return
  const bindingByJira = new Map(bindings.map((b) => [b.jiraId, b]))
  const types = await db.select({ id: schema.issueTypes.id, name: schema.issueTypes.name }).from(schema.issueTypes)
  const typeByName = new Map(types.map((t) => [t.name.toLowerCase(), t.id]))
  const projectByKey = new Map(importedProjects.map((p) => [p.key, p.id]))

  // (project, type) -> the local field ids required there
  const perPair = new Map<string, { projectId: number; typeId: number; fieldIds: Set<number> }>()
  for (const [jiraId, hits] of required) {
    const b = bindingByJira.get(jiraId); if (!b) continue
    for (const h of hits) {
      const projectId = projectByKey.get(h.projectKey); const typeId = typeByName.get(h.issueTypeName.toLowerCase())
      if (projectId === undefined || typeId === undefined) continue
      const k = `${projectId}:${typeId}`
      const e = perPair.get(k) ?? { projectId, typeId, fieldIds: new Set<number>() }
      e.fieldIds.add(b.veqsioId); perPair.set(k, e)
    }
  }
  const nameOfField = new Map(bindings.map((b) => [b.veqsioId, b.name]))
  const configBySet = new Map<string, number>()
  let skippedPairs = 0
  for (const pair of perPair.values()) {
    const ids = [...pair.fieldIds].sort((a, b) => a - b)
    const setKey = ids.join(',')
    let configId = configBySet.get(setKey)
    if (configId === undefined) {
      const name = requiredSetName(ids.map((i) => nameOfField.get(i) ?? String(i)))
      const unique = (await db.select({ id: schema.fieldConfigurations.id }).from(schema.fieldConfigurations).where(sql`${schema.fieldConfigurations.name} like ${name + '%'}`)).length
      const [cfg] = await db.insert(schema.fieldConfigurations).values({ name: unique ? `${name} (${unique + 1})`.slice(0, 255) : name, description: 'Imported from Jira: custom fields that are required when an issue is created' }).returning({ id: schema.fieldConfigurations.id })
      await db.insert(schema.fieldConfigurationItems).values(ids.map((fieldId) => ({ configId: cfg.id, fieldId, isCustomField: true, isVisible: true, isRequired: true })))
      configId = cfg.id
      configBySet.set(setKey, configId)
    }
    const [existing] = await db.select({ configId: schema.fieldConfigurationSchemeAssociations.configId }).from(schema.fieldConfigurationSchemeAssociations)
      .where(and(eq(schema.fieldConfigurationSchemeAssociations.projectId, pair.projectId), eq(schema.fieldConfigurationSchemeAssociations.issueTypeId, pair.typeId))).limit(1)
    if (existing) { skippedPairs++; continue }
    await db.insert(schema.fieldConfigurationSchemeAssociations).values({ projectId: pair.projectId, issueTypeId: pair.typeId, configId })
    report.requiredConfigs = (report.requiredConfigs ?? 0) + 1
  }
  if (skippedPairs) warnings.push(`${skippedPairs} project and issue type pairs already have a field configuration; Jira's required custom fields were not applied to them`)
}
