import { mapFieldType, isStoryPointsField, type JiraFieldMeta, type VeqsioFieldType } from './customfields'

/**
 * Which Veqsio field each Jira custom field becomes: an existing one (found by the Jira id remembered from an earlier import, else
 * by name and a compatible type) or a new one. Pure, so that the preview and the import make the same decisions and the
 * decisions can be tested.
 */

export interface ExistingField { id: number; name: string; fieldType: string }
export type FieldAction = 'match-id' | 'match-name' | 'create' | 'skip'

export interface FieldPlanRow {
  jiraId: string
  jiraName: string
  /** What Jira calls the type (schema type and custom key), for the preview table. */
  jiraType: string
  ourType: VeqsioFieldType | null
  action: FieldAction
  /** The existing field it maps to (match-*). */
  localId?: number
  /** The name of the existing field, or the name the new field gets. */
  localName: string
  /** Why it is skipped, or why a new field got a suffix. */
  reason?: string
  /** The user overrode the automatic decision in the preview. */
  overridden?: boolean
}

export interface FieldOverride { action: 'create' | 'map' | 'skip'; localId?: number }

/** The same type, or a single-choice and a multiple-choice list (both keep the chosen labels as text). */
export function compatibleTypes(a: string, b: string): boolean {
  if (a === b) return true
  const option = (t: string) => t === 'select' || t === 'multiselect'
  return option(a) && option(b)
}

const INTERNAL = /gh-sprint|gh-epic-link|gh-epic-label|gh-lexo-rank|gh-epic-status|gh-epic-color|devsummary|jpo-|greenhopper|proforma|software-|vulnerability|atlassian-team|jira-forge|vote|watch/i

export function jiraTypeLabel(f: JiraFieldMeta): string {
  const t = f.schema?.type ?? 'unknown'
  const items = f.schema?.items ? `<${f.schema.items}>` : ''
  const custom = f.schema?.custom ? ` (${f.schema.custom.split(':').pop()})` : ''
  return `${t}${items}${custom}`
}

/** Why a Jira field is not carried over, in words for the report. */
export function skipReason(f: JiraFieldMeta): string {
  if (!f.custom || !f.id.startsWith('customfield_')) return 'built-in Jira field (handled by the importer itself or not part of the data)'
  if (isStoryPointsField(f)) return 'story points are stored on the issue itself'
  if (INTERNAL.test(f.schema?.custom ?? '')) return 'Jira internal field (rank, sprint, epic link, development panel and similar)'
  return `field type ${jiraTypeLabel(f)} has no counterpart here`
}

export function planFields(
  jira: JiraFieldMeta[], existing: ExistingField[], refs: Map<string, number>, overrides: Record<string, FieldOverride> = {},
): FieldPlanRow[] {
  const byId = new Map(existing.map((e) => [e.id, e]))
  const claimed = new Set<number>()      // existing fields already taken by a row of this plan
  const usedNames = new Set(existing.map((e) => e.name.toLowerCase()))
  const rows: FieldPlanRow[] = []

  // fields with a remembered id come first, so that a name-match never steals the field that belongs to them
  const refTargets = new Set([...refs.values()])
  const ordered = [...jira].sort((a, b) => Number(refs.has(b.id)) - Number(refs.has(a.id)))
  const planned = new Map<string, FieldPlanRow>()

  for (const f of ordered) {
    const ourType = mapFieldType(f)
    const base: FieldPlanRow = { jiraId: f.id, jiraName: f.name, jiraType: jiraTypeLabel(f), ourType, action: 'skip', localName: f.name }
    const ov = overrides[f.id]

    if (ov?.action === 'skip') { planned.set(f.id, { ...base, reason: 'skipped on your choice', overridden: true }); continue }
    if (!ourType) { planned.set(f.id, { ...base, reason: skipReason(f) }); continue }

    if (ov?.action === 'map' && ov.localId !== undefined && byId.has(ov.localId)) {
      const e = byId.get(ov.localId)!
      claimed.add(e.id)
      planned.set(f.id, { ...base, action: 'match-id', localId: e.id, localName: e.name, overridden: true,
        reason: compatibleTypes(ourType, e.fieldType) ? undefined : `existing field is ${e.fieldType}, Jira's is ${ourType}; values are stored as ${e.fieldType}` })
      continue
    }

    const remembered = ov?.action === 'create' ? undefined : refs.get(f.id)
    if (remembered !== undefined && byId.has(remembered) && !claimed.has(remembered)) {
      const e = byId.get(remembered)!
      claimed.add(e.id)
      planned.set(f.id, { ...base, action: 'match-id', localId: e.id, localName: e.name,
        reason: compatibleTypes(ourType, e.fieldType) ? undefined : `existing field is ${e.fieldType}, Jira's is ${ourType}; values are stored as ${e.fieldType}` })
      continue
    }

    const sameName = existing.filter((e) => e.name.toLowerCase() === f.name.toLowerCase())
    if (ov?.action !== 'create') {
      const free = sameName.find((e) => !claimed.has(e.id) && !refTargets.has(e.id) && compatibleTypes(ourType, e.fieldType))
      if (free) { claimed.add(free.id); planned.set(f.id, { ...base, action: 'match-name', localId: free.id, localName: free.name }); continue }
    }

    // a new field; its name must not collide with an existing one or with another new one
    let name = f.name.slice(0, 255)
    let reason: string | undefined
    if (usedNames.has(name.toLowerCase())) {
      const why = sameName.length && !sameName.some((e) => compatibleTypes(ourType, e.fieldType))
        ? `a field named "${f.name}" already exists with another type (${sameName[0].fieldType})`
        : `the name "${f.name}" is already taken`
      name = `${f.name.slice(0, 220)} (${f.id})`
      reason = `${why}; created as "${name}"`
    }
    usedNames.add(name.toLowerCase())
    planned.set(f.id, { ...base, action: 'create', localName: name, reason, overridden: ov?.action === 'create' ? true : undefined })
  }

  // keep the order Jira gave
  for (const f of jira) rows.push(planned.get(f.id)!)
  return rows
}
