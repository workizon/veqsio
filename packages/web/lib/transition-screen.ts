/**
 * Pure helpers of the transition dialog's screen fields: initial values from the issue, client side validation (the
 * server validates again and answers with per-field errors), and the REST payload. No React, no network.
 */

export type ScreenFieldType =
  | 'resolution' | 'user' | 'priority' | 'labels' | 'versions' | 'components' | 'date' | 'number' | 'text' | 'comment'
  | 'string' | 'textarea' | 'select' | 'multiselect' | 'boolean' | 'url' | 'datetime' | 'userpicker' | 'other'

export interface ScreenField {
  key: string
  name: string
  type: ScreenFieldType
  custom: boolean
  required: boolean
  options?: string[]
}

export interface RefValue { id: number; name: string }
export interface UserValue { id: number; displayName: string }
export interface PriorityValue { id: number; name: string; color?: string }

/** Value state per field key: user -> UserValue | null, priority -> PriorityValue | null, labels -> string[], versions/components -> RefValue[], everything else -> string (checkbox: 'true' | ''). */
export type ScreenValues = Record<string, unknown>

/** Dedicated inputs of the dialog: resolution and comment have their own widgets, the rest is rendered from the screen. */
export const DEDICATED_KEYS = new Set(['resolution', 'comment'])

export function screenFieldsOf(t: { screenFields?: ScreenField[] | null }): ScreenField[] {
  return Array.isArray(t.screenFields) ? t.screenFields : []
}

/** Fields the dialog renders through the shared issue-view editors (everything except resolution and comment). */
export function generalScreenFields(t: { screenFields?: ScreenField[] | null }): ScreenField[] {
  return screenFieldsOf(t).filter((f) => !DEDICATED_KEYS.has(f.key))
}

export function screenRequires(t: { screenFields?: ScreenField[] | null }, key: string): boolean {
  return screenFieldsOf(t).some((f) => f.key === key && f.required)
}

export function screenHasField(t: { screenFields?: ScreenField[] | null }, key: string): boolean {
  return screenFieldsOf(t).some((f) => f.key === key)
}

interface IssueFieldsLike {
  assignee?: { id: number; displayName: string } | null
  priority?: { id: number; name: string; color?: string } | null
  labels?: string[]
  fixVersions?: RefValue[]
  components?: RefValue[]
  duedate?: string | null
  storyPoints?: number | null
  environment?: string | null
  [k: string]: any
}

/** Start values: what the issue has now, so required fields it already has are pre-filled. */
export function initialScreenValues(fields: ScreenField[], issue: IssueFieldsLike | undefined): ScreenValues {
  const out: ScreenValues = {}
  const f = issue ?? {}
  for (const d of fields) {
    if (DEDICATED_KEYS.has(d.key)) continue
    switch (d.key) {
      case 'assignee': out.assignee = f.assignee ? { id: f.assignee.id, displayName: f.assignee.displayName } : null; break
      case 'priority': out.priority = f.priority ? { id: f.priority.id, name: f.priority.name, color: f.priority.color } : null; break
      case 'labels': out.labels = [...(f.labels ?? [])]; break
      case 'fixVersions': out.fixVersions = (f.fixVersions ?? []).map((v) => ({ id: v.id, name: v.name })); break
      case 'components': out.components = (f.components ?? []).map((v) => ({ id: v.id, name: v.name })); break
      case 'duedate': out.duedate = f.duedate ?? ''; break
      case 'storyPoints': out.storyPoints = f.storyPoints === null || f.storyPoints === undefined ? '' : String(f.storyPoints); break
      case 'environment': out.environment = f.environment ?? ''; break
      default: {
        if (d.custom) {
          const v = f[d.key]
          out[d.key] = v === null || v === undefined ? '' : d.type === 'boolean' ? (v ? 'true' : '') : d.type === 'date' || d.type === 'datetime' ? String(v).slice(0, d.type === 'date' ? 10 : 16) : String(v)
        }
      }
    }
  }
  return out
}

const empty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)

/** '' -> null (clear); otherwise a number 0..1000 with at most 2 decimals; undefined = invalid. Mirrors the server rule. */
export function parseStoryPoints(raw: string): number | null | undefined {
  const s = raw.trim().replace(',', '.')
  if (s === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined
  const n = Number(s)
  return n >= 0 && n <= 1000 ? n : undefined
}

/** Client side check; the server answers 400 with the same keys, which the dialog shows inline too. */
export function validateScreenValues(fields: ScreenField[], values: ScreenValues, extra: { resolutionId?: string; comment?: string } = {}): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const d of fields) {
    if (d.key === 'resolution') { if (d.required && !extra.resolutionId) errors.resolution = 'Resolution is required'; continue }
    if (d.key === 'comment') { if (d.required && !(extra.comment ?? '').trim()) errors.comment = 'Comment is required'; continue }
    const v = values[d.key]
    if (d.required && empty(v)) { errors[d.key] = `${d.name} is required`; continue }
    if (empty(v)) continue
    if (d.key === 'storyPoints' && parseStoryPoints(String(v)) === undefined) errors[d.key] = 'Enter a number from 0 to 1000 (max 2 decimals)'
    else if (d.key === 'duedate' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) errors[d.key] = 'Enter a valid date'
    else if (d.key === 'labels' && (v as string[]).some((l) => /\s/.test(l))) errors[d.key] = 'Labels cannot contain spaces'
    else if (d.custom && d.type === 'number' && !Number.isFinite(Number(String(v).replace(',', '.')))) errors[d.key] = `${d.name} must be a number`
    else if (d.custom && d.type === 'select' && d.options?.length && !d.options.includes(String(v))) errors[d.key] = `${d.name} must be one of the listed options`
  }
  return errors
}

/** `fields` for POST /transitions: Jira shapes (assignee {id}, priority {id}, [{id}] lists, customfield_N). */
export function buildScreenPayload(fields: ScreenField[], values: ScreenValues): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const d of fields) {
    if (DEDICATED_KEYS.has(d.key)) continue
    const v = values[d.key]
    switch (d.key) {
      case 'assignee': out.assignee = v ? { id: (v as UserValue).id } : null; break
      case 'priority': out.priority = v ? { id: (v as PriorityValue).id } : null; break
      case 'labels': out.labels = (v as string[] | undefined) ?? []; break
      case 'fixVersions': out.fixVersions = ((v as RefValue[] | undefined) ?? []).map((x) => ({ id: x.id })); break
      case 'components': out.components = ((v as RefValue[] | undefined) ?? []).map((x) => ({ id: x.id })); break
      case 'duedate': out.duedate = empty(v) ? null : String(v); break
      case 'storyPoints': out.storyPoints = empty(v) ? null : parseStoryPoints(String(v)); break
      case 'environment': out.environment = typeof v === 'string' ? v : ''; break
      default:
        if (d.custom) {
          if (d.type === 'number') out[d.key] = empty(v) ? null : Number(String(v).replace(',', '.'))
          else if (d.type === 'boolean') out[d.key] = v === 'true'
          else out[d.key] = empty(v) ? null : String(v)
        }
    }
  }
  return out
}

/** Server `errors` (field key -> message) limited to keys the dialog knows; anything else goes to the general list. */
export function splitServerErrors(fields: ScreenField[], errors: Record<string, string> | undefined, general: string[] | undefined): { byField: Record<string, string>; general: string[] } {
  const known = new Set(fields.map((f) => f.key))
  const byField: Record<string, string> = {}
  const covered = new Set<string>()
  for (const [k, m] of Object.entries(errors ?? {})) {
    if (known.has(k)) { byField[k] = m; covered.add(m) }
  }
  return { byField, general: (general ?? []).filter((m) => !covered.has(m)) }
}
