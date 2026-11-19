import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'

/**
 * Rules the configuration puts on the custom fields of a new issue: which ones must be filled in (a field configuration with
 * "required" for the project and issue type) and what an empty one starts as (the default of the context that matches the project
 * and issue type, else the field's own default).
 */

export interface FieldRuleFacts {
  /** Custom fields marked required in the field configuration of the project and issue type. */
  requiredIds: number[]
  fields: Array<{ id: number; name: string; defaultValue: string | null }>
  contexts: Array<{ customFieldId: number; projectId: number | null; issueTypeId: number | null; defaultValue: string | null }>
}

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)
}

/** The default for a field in a project and issue type: the most specific matching context that has one, else the field's own. */
export function defaultFor(fieldId: number, projectId: number, issueTypeId: number, facts: FieldRuleFacts): string | null {
  const own = facts.contexts.filter((c) => c.customFieldId === fieldId && c.defaultValue !== null && (c.projectId === null || c.projectId === projectId) && (c.issueTypeId === null || c.issueTypeId === issueTypeId))
  const best = own.sort((a, b) => Number(b.projectId !== null) + Number(b.issueTypeId !== null) - (Number(a.projectId !== null) + Number(a.issueTypeId !== null)))[0]
  if (best) return best.defaultValue
  return facts.fields.find((f) => f.id === fieldId)?.defaultValue ?? null
}

/** Provided values plus the defaults of the fields left out, and the names of the required fields that are still empty. */
export function applyFieldRules(
  provided: Array<{ fieldId: number; value: unknown }> | undefined, projectId: number, issueTypeId: number, facts: FieldRuleFacts,
): { values: Array<{ fieldId: number; value: unknown }>; missing: string[] } {
  const values = [...(provided ?? [])]
  const have = new Map(values.map((v) => [v.fieldId, v]))
  // a default only fills a field that applies (has a context default, or is required, or has its own default): a field the caller did not send
  for (const f of facts.fields) {
    const sent = have.get(f.id)
    if (sent && !isEmptyValue(sent.value)) continue
    const d = defaultFor(f.id, projectId, issueTypeId, facts)
    if (d !== null && (facts.requiredIds.includes(f.id) || facts.contexts.some((c) => c.customFieldId === f.id && c.defaultValue !== null))) {
      if (sent) sent.value = d; else values.push({ fieldId: f.id, value: d })
    }
  }
  const filled = new Map(values.map((v) => [v.fieldId, v.value]))
  const missing = facts.requiredIds.filter((id) => isEmptyValue(filled.get(id))).map((id) => facts.fields.find((f) => f.id === id)?.name ?? `customfield_${id}`)
  return { values, missing }
}

export async function loadFieldRuleFacts(projectId: number, issueTypeId: number): Promise<FieldRuleFacts> {
  const [assoc] = await db.select({ configId: schema.fieldConfigurationSchemeAssociations.configId }).from(schema.fieldConfigurationSchemeAssociations)
    .where(and(eq(schema.fieldConfigurationSchemeAssociations.projectId, projectId), eq(schema.fieldConfigurationSchemeAssociations.issueTypeId, issueTypeId))).limit(1)
  const items = assoc ? await db.select().from(schema.fieldConfigurationItems).where(eq(schema.fieldConfigurationItems.configId, assoc.configId)) : []
  const requiredIds = items.filter((i) => i.isRequired && i.isCustomField).map((i) => i.fieldId)
  const fields = await db.select({ id: schema.customFields.id, name: schema.customFields.name, defaultValue: schema.customFields.defaultValue }).from(schema.customFields)
  const contexts = fields.length
    ? await db.select({ customFieldId: schema.customFieldContexts.customFieldId, projectId: schema.customFieldContexts.projectId, issueTypeId: schema.customFieldContexts.issueTypeId, defaultValue: schema.customFieldContexts.defaultValue })
        .from(schema.customFieldContexts).where(inArray(schema.customFieldContexts.customFieldId, fields.map((f) => f.id)))
    : []
  return { requiredIds, fields, contexts }
}
