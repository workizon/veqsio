import { setCustomFields, isHttpUrl } from '../../issues/custom-fields'
import type { Resolver } from '../resolver'
import { normalizeUser, type JiraUserRef } from './mapper'

export type VeqsioFieldType = 'string' | 'text' | 'number' | 'date' | 'datetime' | 'user' | 'url' | 'select' | 'multiselect' | 'checkbox'

export interface JiraFieldMeta {
  id: string
  name: string
  custom?: boolean
  schema?: { type?: string; items?: string; custom?: string }
}

/** Custom fields that are Jira plumbing (ranking, sprint, epic link, dev panel) and have no equivalent value to copy. */
const SKIP_CUSTOM = /gh-sprint|gh-epic-link|gh-epic-label|gh-lexo-rank|gh-epic-status|gh-epic-color|devsummary|jpo-|greenhopper|proforma|software-|vulnerability|atlassian-team|jira-forge|vote|watch/i

/** Jira's story point estimate is a first-class Veqsio field (`issues.story_points`), not a custom field. */
export function isStoryPointsField(f: JiraFieldMeta): boolean {
  if (!f.id.startsWith('customfield_')) return false
  const name = (f.name ?? '').trim().toLowerCase()
  return name === 'story points' || name === 'story point estimate' || /jsw-story-points/i.test(f.schema?.custom ?? '')
}

/** Ids (customfield_NNNNN) of every Jira field that carries story points. */
export function storyPointFieldIds(metas: JiraFieldMeta[]): string[] {
  return metas.filter(isStoryPointsField).map((f) => f.id)
}

/** First usable story-point value of an issue's raw fields: 0..1000, rounded to 2 decimals; else null. */
export function extractStoryPoints(fields: Record<string, unknown> | undefined, ids: string[]): number | null {
  if (!fields) return null
  for (const id of ids) {
    const raw = fields[id]
    if (raw === null || raw === undefined || raw === '') continue
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(',', '.')) : NaN
    if (Number.isFinite(n) && n >= 0 && n <= 1000) return Math.round(n * 100) / 100
  }
  return null
}

/** Decide how a Jira field maps to a Veqsio field type; null = not migrated. */
export function mapFieldType(f: JiraFieldMeta): VeqsioFieldType | null {
  if (!f.custom || !f.id.startsWith('customfield_')) return null
  if (isStoryPointsField(f)) return null
  const custom = f.schema?.custom ?? ''
  if (SKIP_CUSTOM.test(custom)) return null
  const type = f.schema?.type
  if (type === 'number') return 'number'
  if (type === 'date') return 'date'
  if (type === 'datetime') return 'datetime'
  if (type === 'user') return 'user'
  if (type === 'option' || type === 'option-with-child') return 'select'
  if (type === 'array') {
    const items = f.schema?.items
    if (items === 'option' || items === 'string' || items === 'version' || items === 'component' || items === 'group' || items === 'user') return 'multiselect'
    return null
  }
  if (type === 'string') {
    if (/url/.test(custom)) return 'url'
    if (/textarea/.test(custom)) return 'text'
    if (/select|radio/.test(custom)) return 'select'
    return 'string'
  }
  return null
}

export interface FieldBinding { jiraId: string; veqsioId: number; type: VeqsioFieldType; name: string }

type Scalar = string | number | boolean | JiraUserRef

function scalarOf(v: any): Scalar | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'object') {
    if ('emailAddress' in v || 'accountId' in v || ('displayName' in v && 'name' in v)) return v as JiraUserRef
    const base = v.value ?? v.name ?? v.displayName ?? v.key
    if (base === undefined) return null
    const child = v.child?.value
    return child ? `${base} / ${child}` : String(base)
  }
  return null
}

/** Convert a raw Jira value into what Veqsio's setCustomFields expects, or undefined to skip. */
export async function convertValue(b: FieldBinding, raw: any, resolver: Resolver): Promise<unknown | undefined> {
  if (raw === null || raw === undefined) return undefined
  if (b.type === 'user') {
    const u = normalizeUser(scalarOf(raw) as JiraUserRef)
    return (await resolver.user(u)) ?? undefined
  }
  if (Array.isArray(raw)) {
    const parts = raw.map((x) => scalarOf(x)).filter((x): x is Scalar => x !== null)
      .map((x) => (typeof x === 'object' ? (x as JiraUserRef).displayName ?? (x as JiraUserRef).name ?? '' : String(x)))
      .filter(Boolean)
    return parts.length ? parts.join(', ').slice(0, 500) : undefined
  }
  const s = scalarOf(raw)
  if (s === null) return undefined
  if (b.type === 'url') return isHttpUrl(String(s)) ? String(s).slice(0, 500) : undefined
  if (b.type === 'number') return Number.isFinite(Number(s)) ? Number(s) : undefined
  if (b.type === 'date' || b.type === 'datetime') return Number.isNaN(new Date(String(s)).getTime()) ? undefined : new Date(String(s)).toISOString()
  if (typeof s === 'object') return (s as JiraUserRef).displayName ?? undefined
  return b.type === 'text' ? String(s) : String(s).slice(0, 500)
}

export async function writeCustomValues(
  issueId: number, raw: Record<string, unknown>, bindings: FieldBinding[], resolver: Resolver,
): Promise<number> {
  const fields: Array<{ fieldId: number; value: unknown }> = []
  for (const b of bindings) {
    const value = await convertValue(b, raw[b.jiraId], resolver)
    if (value !== undefined) fields.push({ fieldId: b.veqsioId, value })
  }
  if (fields.length) await setCustomFields(issueId, fields)
  return fields.length
}
