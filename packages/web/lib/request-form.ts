/**
 * Request form model shared by the portal, the form builder preview and the builder itself.
 * Mirrors the server rules in packages/api/src/servicedesk/form.ts (the server stays authoritative).
 */

export type FieldType =
  | 'text' | 'textarea' | 'select' | 'checkbox' | 'date' | 'number'
  | 'multiselect' | 'checkboxes' | 'radio' | 'datetime' | 'url' | 'email' | 'user' | 'attachment' | 'section' | 'help'

export type MappingTarget = 'none' | 'summary' | 'description' | 'priority' | 'labels' | 'components' | 'dueDate' | 'assignee' | 'customField'
export type ConditionOp = 'equals' | 'notEquals' | 'in' | 'filled'
export type FieldValue = string | number | boolean | string[]

export interface FieldDef {
  key: string
  label: string
  type: FieldType | (string & {}) // unknown future types render as text
  required?: boolean
  options?: string[]
  helpText?: string
  placeholder?: string
  internal?: boolean
  defaultValue?: FieldValue
  validation?: { minLength?: number; maxLength?: number; pattern?: string; min?: number; max?: number }
  visibleWhen?: { field: string; op?: ConditionOp; value?: string | number | boolean | Array<string | number | boolean> }
  mapping?: { target: MappingTarget; customFieldId?: number }
}

export const CHOICE_TYPES = ['select', 'multiselect', 'checkboxes', 'radio']
export const LAYOUT_TYPES = ['section', 'help']
export const isChoice = (t: string) => CHOICE_TYPES.includes(t)
export const isLayout = (t: string) => LAYOUT_TYPES.includes(t)

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)

function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((a) => matches(a, expected))
  if (typeof actual === 'boolean') return String(actual) === String(expected)
  if (typeof actual === 'number') return actual === Number(expected)
  return actual === expected
}

export function evaluateCondition(cond: NonNullable<FieldDef['visibleWhen']>, values: Record<string, unknown>): boolean {
  const actual = own(values, cond.field) ? values[cond.field] : undefined
  switch (cond.op ?? 'equals') {
    case 'filled': return !isEmpty(actual)
    case 'notEquals': return !matches(actual, cond.value)
    case 'in': return Array.isArray(cond.value) && cond.value.some((e) => matches(actual, e))
    default: return !isEmpty(actual) && matches(actual, cond.value)
  }
}

/** Keys of the fields that are visible for the current values (hidden fields count as empty for later conditions). */
export function visibleKeys(fields: FieldDef[], values: Record<string, unknown>): Set<string> {
  const visible = new Set<string>()
  const effective: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.visibleWhen && !evaluateCondition(f.visibleWhen, effective)) continue
    visible.add(f.key)
    if (own(values, f.key)) effective[f.key] = values[f.key]
  }
  return visible
}

/** Initial values: configured defaults for customer-facing value fields. */
export function initialValues(fields: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.internal || isLayout(f.type) || f.type === 'attachment') continue
    if (f.defaultValue !== undefined) out[f.key] = Array.isArray(f.defaultValue) ? [...f.defaultValue] : f.defaultValue
  }
  return out
}

/** Only the values of visible fields; this is what gets submitted. */
export function submittableValues(fields: FieldDef[], values: Record<string, unknown>): Record<string, unknown> {
  const visible = visibleKeys(fields, values)
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (!visible.has(f.key) || f.internal || isLayout(f.type) || f.type === 'attachment') continue
    if (own(values, f.key) && !isEmpty(values[f.key])) out[f.key] = values[f.key]
  }
  return out
}

/** Client-side validation for instant feedback: label-keyed messages for visible fields. */
export function validateValues(fields: FieldDef[], values: Record<string, unknown>, files: Record<string, unknown[]> = {}): Record<string, string> {
  const errors: Record<string, string> = {}
  const visible = visibleKeys(fields, values)
  for (const f of fields) {
    if (!visible.has(f.key) || f.internal || isLayout(f.type)) continue
    if (f.type === 'attachment') {
      if (f.required && !(files[f.key]?.length)) errors[f.key] = `${f.label} is required`
      continue
    }
    const v = values[f.key]
    if (isEmpty(v)) {
      if (f.required && f.type !== 'checkbox') errors[f.key] = `${f.label} is required`
      continue
    }
    const val = f.validation
    if (typeof v === 'string') {
      if (val?.minLength != null && v.length < val.minLength) errors[f.key] = `${f.label} must be at least ${val.minLength} characters`
      else if (val?.maxLength != null && v.length > val.maxLength) errors[f.key] = `${f.label} must be at most ${val.maxLength} characters`
      else if (val?.pattern) {
        try { if (!new RegExp(val.pattern).test(v)) errors[f.key] = `${f.label} has an invalid format` } catch { /* server decides */ }
      }
      if (!errors[f.key] && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) errors[f.key] = `${f.label} must be an email address`
      if (!errors[f.key] && f.type === 'user' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) errors[f.key] = `${f.label} must be an email address`
      if (!errors[f.key] && f.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) errors[f.key] = `${f.label} must be a valid http(s) URL`
    }
    if (typeof v === 'number') {
      if (val?.min != null && v < val.min) errors[f.key] = `${f.label} must be at least ${val.min}`
      else if (val?.max != null && v > val.max) errors[f.key] = `${f.label} must be at most ${val.max}`
    }
  }
  return errors
}

/** `datetime-local` input value <-> ISO string. */
export const toLocalInput = (iso: unknown): string => (typeof iso === 'string' && iso ? iso.slice(0, 16) : '')
export const fromLocalInput = (v: string): string | undefined => {
  if (!v) return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}
