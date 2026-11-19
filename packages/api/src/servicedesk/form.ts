/**
 * Request form engine: field definitions, conditional visibility, validation and mapping into
 * issue fields. Pure (no DB access) so it is fully unit-testable; name/user resolution happens in
 * form-resolve.ts. Everything here is additive and backwards compatible with request types stored
 * before the form builder existed (legacy types: text, textarea, select, checkbox, date, number).
 */

export const LEGACY_FIELD_TYPES = ['text', 'textarea', 'select', 'checkbox', 'date', 'number'] as const
export const FIELD_TYPES = [
  ...LEGACY_FIELD_TYPES,
  'multiselect', 'checkboxes', 'radio', 'datetime', 'url', 'email', 'user', 'attachment', 'section', 'help',
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const CHOICE_TYPES: readonly FieldType[] = ['select', 'multiselect', 'checkboxes', 'radio']
export const MULTI_TYPES: readonly FieldType[] = ['multiselect', 'checkboxes']
/** Display-only elements: they carry no value. */
export const LAYOUT_TYPES: readonly FieldType[] = ['section', 'help']
/** Types whose value is a plain string typed by the customer. */
const TEXT_TYPES: readonly FieldType[] = ['text', 'textarea', 'url', 'email', 'user']

export const MAPPING_TARGETS = [
  'none', 'summary', 'description', 'priority', 'labels', 'components', 'dueDate', 'assignee', 'customField',
] as const
export type MappingTarget = (typeof MAPPING_TARGETS)[number]

export interface FieldMapping { target: MappingTarget; customFieldId?: number }
export interface FieldValidation { minLength?: number; maxLength?: number; pattern?: string; min?: number; max?: number }
export type ConditionOp = 'equals' | 'notEquals' | 'in' | 'filled'
export interface VisibleWhen { field: string; op?: ConditionOp; value?: string | number | boolean | Array<string | number | boolean> }
export type FieldValue = string | number | boolean | string[]

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  required?: boolean
  options?: string[]
  helpText?: string
  placeholder?: string
  /** Internal-only (agent) field: never shown to or accepted from customers. */
  internal?: boolean
  defaultValue?: FieldValue
  validation?: FieldValidation
  visibleWhen?: VisibleWhen
  /** Absent = legacy behaviour (value is rendered into the description). */
  mapping?: FieldMapping
}

/** Keys that would shadow Object.prototype members; also keeps `__proto__` impossible (key regex starts with a letter). */
const RESERVED_KEYS = new Set([
  'constructor', 'prototype', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'toString', 'toLocaleString', 'valueOf', 'proto',
])
export const FIELD_KEY_RE = /^[a-z][a-zA-Z0-9_]{0,49}$/
export const isSafeFieldKey = (k: string) => FIELD_KEY_RE.test(k) && !RESERVED_KEYS.has(k)

const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const isLayout = (f: FieldDef) => LAYOUT_TYPES.includes(f.type)
const isEmptyValue = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/* ------------------------------------------------------------------ */
/*  Conditional visibility                                              */
/* ------------------------------------------------------------------ */

function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((a) => matches(a, expected))
  if (typeof actual === 'boolean') return String(actual) === String(expected)
  if (typeof actual === 'number') return actual === Number(expected)
  return actual === expected
}

export function evaluateCondition(cond: VisibleWhen, values: Record<string, unknown>): boolean {
  const actual = own(values, cond.field) ? values[cond.field] : undefined
  switch (cond.op ?? 'equals') {
    case 'filled': return !isEmptyValue(actual)
    case 'notEquals': return !matches(actual, cond.value)
    case 'in': return Array.isArray(cond.value) && cond.value.some((e) => matches(actual, e))
    default: return !isEmptyValue(actual) && matches(actual, cond.value)
  }
}

/**
 * Which fields are visible given the (already accepted) values of the fields before them.
 * Hidden fields count as empty for later conditions, so hiding cascades.
 */
export function visibleKeys(defs: FieldDef[], values: Record<string, unknown>): Set<string> {
  const visible = new Set<string>()
  const effective: Record<string, unknown> = {}
  for (const f of defs) {
    const show = !f.visibleWhen || evaluateCondition(f.visibleWhen, effective)
    if (!show) continue
    visible.add(f.key)
    if (own(values, f.key)) effective[f.key] = values[f.key]
  }
  return visible
}

/* ------------------------------------------------------------------ */
/*  Validation                                                          */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/
const MAX_TEXT = 10_000

export function safePattern(pattern: string): RegExp | null {
  if (pattern.length > 200) return null
  // Reject the classic catastrophic shapes: a quantified group that itself contains a quantifier.
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return null
  // alternation inside a repeated group, `(a|aa)+`, is the other classic: refuse repeated groups that contain `|`
  if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern)) return null
  try { return new RegExp(pattern) } catch { return null }
}

function checkText(f: FieldDef, v: string, errors: string[]): boolean {
  const val = f.validation
  if (val?.minLength != null && v.length < val.minLength) { errors.push(`${f.label} must be at least ${val.minLength} characters`); return false }
  if (val?.maxLength != null && v.length > val.maxLength) { errors.push(`${f.label} must be at most ${val.maxLength} characters`); return false }
  if (val?.pattern) {
    const re = safePattern(val.pattern)
    if (re && !re.test(v)) { errors.push(`${f.label} has an invalid format`); return false }
  }
  return true
}

export type ValidationResult =
  | { ok: true; values: Record<string, FieldValue> }
  | { ok: false; errors: string[] }

/**
 * Validate customer-submitted values against a form. Unknown keys are dropped; hidden fields and
 * internal-only fields are ignored (internal fields only ever receive their configured default);
 * required applies only to visible fields.
 */
export function validateFieldValues(defs: FieldDef[], values: Record<string, unknown>): ValidationResult {
  const errors: string[] = []
  const out: Record<string, FieldValue> = {}
  // Customers cannot supply internal fields: treat them as absent for visibility purposes too.
  const supplied: Record<string, unknown> = {}
  for (const f of defs) if (!f.internal && !isLayout(f) && own(values, f.key)) supplied[f.key] = values[f.key]
  const visible = visibleKeys(defs, supplied)

  for (const f of defs) {
    if (isLayout(f) || f.type === 'attachment') continue
    if (!visible.has(f.key)) continue
    if (f.internal) {
      if (f.defaultValue !== undefined && !isEmptyValue(f.defaultValue)) out[f.key] = f.defaultValue
      continue
    }
    const raw = supplied[f.key]
    const v = typeof raw === 'string' ? cleanText(raw) : raw
    if (isEmptyValue(v)) {
      if (f.required && f.type !== 'checkbox') errors.push(`${f.label} is required`)
      continue
    }
    switch (f.type) {
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${f.label} must be a number`)
        else if (f.validation?.min != null && v < f.validation.min) errors.push(`${f.label} must be at least ${f.validation.min}`)
        else if (f.validation?.max != null && v > f.validation.max) errors.push(`${f.label} must be at most ${f.validation.max}`)
        else out[f.key] = v
        break
      case 'checkbox':
        if (typeof v !== 'boolean') errors.push(`${f.label} must be true/false`)
        else out[f.key] = v
        break
      case 'select':
      case 'radio':
        if (typeof v !== 'string' || !(f.options ?? []).includes(v)) errors.push(`${f.label} has an invalid option`)
        else out[f.key] = v
        break
      case 'multiselect':
      case 'checkboxes': {
        const opts = f.options ?? []
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !opts.includes(x))) errors.push(`${f.label} has an invalid option`)
        else out[f.key] = [...new Set(v as string[])]
        break
      }
      case 'date':
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) errors.push(`${f.label} must be a date`)
        else out[f.key] = v
        break
      case 'datetime':
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) errors.push(`${f.label} must be a date and time`)
        else out[f.key] = v
        break
      case 'url': {
        let ok = false
        if (typeof v === 'string' && v.length <= 2000) {
          try { const u = new URL(v); ok = u.protocol === 'http:' || u.protocol === 'https:' } catch { /* invalid */ }
        }
        if (!ok) errors.push(`${f.label} must be a valid http(s) URL`)
        else if (checkText(f, v as string, errors)) out[f.key] = v as string
        break
      }
      case 'email':
      case 'user':
        if (typeof v !== 'string' || v.length > 320 || !EMAIL_RE.test(v)) errors.push(`${f.label} must be an email address`)
        else if (checkText(f, v, errors)) out[f.key] = v
        break
      default: { // text, textarea
        // NUL and other control characters are stripped: Postgres rejects \u0000 in text/jsonb (would be a 500).
        const t = typeof v === 'string' ? cleanText(v) : v
        if (typeof t !== 'string' || t.length > MAX_TEXT) errors.push(`${f.label} must be text up to ${MAX_TEXT} chars`)
        else if (checkText(f, t, errors)) out[f.key] = t
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, values: out }
}

/* ------------------------------------------------------------------ */
/*  Definition validation (admin saving a form)                         */
/* ------------------------------------------------------------------ */

const ISSUE_MAP_TYPES: Record<MappingTarget, readonly FieldType[] | 'any'> = {
  none: 'any',
  summary: ['text'],
  description: ['text', 'textarea'],
  priority: ['select', 'radio'],
  labels: ['text', 'select', 'radio', 'multiselect', 'checkboxes'],
  components: ['select', 'radio', 'multiselect', 'checkboxes'],
  dueDate: ['date', 'datetime'],
  assignee: ['user'],
  customField: 'any',
}

/** Returns human readable problems; empty array = the form definition is acceptable. */
export function validateFormDefinition(defs: FieldDef[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const singleTargets = new Set<MappingTarget>()
  defs.forEach((f, i) => {
    const name = f.label || f.key
    if (!isSafeFieldKey(f.key)) problems.push(`${name}: invalid field key "${f.key}"`)
    if (seen.has(f.key)) problems.push(`${name}: duplicate field key "${f.key}"`)
    seen.add(f.key)

    if (CHOICE_TYPES.includes(f.type)) {
      const opts = f.options ?? []
      if (opts.length === 0) problems.push(`${name}: add at least one option`)
      if (new Set(opts).size !== opts.length) problems.push(`${name}: options must be unique`)
    } else if (f.options?.length) problems.push(`${name}: options are only allowed on choice fields`)

    if (isLayout(f)) {
      if (f.required || (f.mapping && f.mapping.target !== 'none') || f.internal) {
        problems.push(`${name}: section headers and help text cannot be required, internal or mapped`)
      }
    }
    const v = f.validation
    if (v) {
      const textual = TEXT_TYPES.includes(f.type)
      if ((v.minLength != null || v.maxLength != null || v.pattern != null) && !textual) problems.push(`${name}: length and pattern rules apply to text fields only`)
      if ((v.min != null || v.max != null) && f.type !== 'number') problems.push(`${name}: min/max apply to number fields only`)
      if (v.minLength != null && v.maxLength != null && v.minLength > v.maxLength) problems.push(`${name}: minimum length exceeds maximum length`)
      if (v.min != null && v.max != null && v.min > v.max) problems.push(`${name}: minimum exceeds maximum`)
      if (v.pattern != null && !safePattern(v.pattern)) problems.push(`${name}: the pattern is not a valid, safe regular expression`)
    }
    if (f.visibleWhen) {
      const idx = defs.findIndex((d) => d.key === f.visibleWhen!.field)
      if (idx === -1) problems.push(`${name}: condition refers to an unknown field`)
      else if (idx >= i) problems.push(`${name}: a condition may only refer to a field above it`)
      else if (isLayout(defs[idx])) problems.push(`${name}: a condition cannot refer to a section or help text`)
      else if (f.visibleWhen.op === 'in' && !Array.isArray(f.visibleWhen.value)) problems.push(`${name}: "in" conditions need a list of values`)
    }
    if (f.defaultValue !== undefined) {
      if (isLayout(f) || f.type === 'attachment') problems.push(`${name}: this element cannot have a default`)
      else {
        const probe = validateFieldValues([{ ...f, required: false, internal: false, visibleWhen: undefined, mapping: undefined }], { [f.key]: f.defaultValue })
        if (!probe.ok) problems.push(`${name}: default value is invalid (${probe.errors[0]})`)
      }
    }
    if (f.mapping) {
      const t = f.mapping.target
      const allowed = ISSUE_MAP_TYPES[t]
      if (allowed !== 'any' && !allowed.includes(f.type)) problems.push(`${name}: a ${f.type} field cannot be mapped to ${t}`)
      if (t === 'customField' && !f.mapping.customFieldId) problems.push(`${name}: choose the custom field to map to`)
      if (t !== 'customField' && f.mapping.customFieldId != null) problems.push(`${name}: customFieldId is only valid for custom field mappings`)
      if (f.internal && (t === 'summary' || t === 'description')) problems.push(`${name}: internal fields cannot map to summary or description (customers can read them)`)
      if (t === 'summary' || t === 'dueDate' || t === 'assignee' || t === 'priority') {
        if (singleTargets.has(t)) problems.push(`${name}: another field is already mapped to ${t}`)
        singleTargets.add(t)
      }
    }
  })
  if (defs.length > 50) problems.push('A form can have at most 50 fields')
  return problems
}

/* ------------------------------------------------------------------ */
/*  Customer-facing projection                                          */
/* ------------------------------------------------------------------ */

/** What the portal may see: internal fields and all mapping configuration are removed. */
export function toPortalFields(defs: FieldDef[]): Array<Omit<FieldDef, 'internal' | 'mapping'>> {
  return defs.filter((f) => !f.internal).map((f) => {
    const { internal: _i, mapping: _m, ...rest } = f
    return rest
  })
}

/** True when a visible customer-facing field is mapped to the target (so the portal can hide the generic input). */
export function hasMappedField(defs: FieldDef[], target: MappingTarget): boolean {
  return defs.some((f) => !f.internal && f.mapping?.target === target)
}

/* ------------------------------------------------------------------ */
/*  Mapping into the issue                                              */
/* ------------------------------------------------------------------ */

/** Strip control characters (keeps tab and newline); values end up in markup-ish issue text. */
export function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function display(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) return v.map((x) => cleanText(String(x))).join(', ')
  return cleanText(String(v))
}

/** Render submitted values into the issue description (legacy fields and unmapped fields only). */
export function renderDescription(defs: FieldDef[], values: Record<string, unknown>, body?: string): string {
  const parts: string[] = []
  if (body) parts.push(body)
  for (const f of defs) {
    if (isLayout(f) || f.type === 'attachment') continue
    // The description is visible to customers: never include internal values or explicitly mapped fields.
    if (f.internal) continue
    if (f.mapping && f.mapping.target !== 'description') continue
    if (!own(values, f.key)) continue
    const v = values[f.key]
    if (v === undefined || v === null) continue
    if (f.mapping?.target === 'description') parts.push(display(v))
    else parts.push(`*${cleanText(f.label)}*: ${display(v)}`)
  }
  return parts.join('\n\n')
}

export interface MappedIssueFields {
  summary?: string
  priorityName?: string
  labels: string[]
  componentNames: string[]
  dueDate?: string
  assigneeEmail?: string
  customFields: Array<{ customFieldId: number; value: unknown }>
}

export function sanitizeLabel(s: string): string {
  return cleanText(s).trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_.:/-]/gu, '').slice(0, 100)
}

/** Collect the values that map onto issue fields (names/emails still unresolved). */
export function mapFieldValues(defs: FieldDef[], values: Record<string, unknown>): MappedIssueFields {
  const out: MappedIssueFields = { labels: [], componentNames: [], customFields: [] }
  for (const f of defs) {
    if (!f.mapping || f.mapping.target === 'none' || !own(values, f.key)) continue
    const v = values[f.key]
    if (isEmptyValue(v)) continue
    const list = (Array.isArray(v) ? v : [v]).map((x) => String(x))
    switch (f.mapping.target) {
      case 'summary': out.summary = cleanText(list[0]).replace(/\s+/g, ' ').trim().slice(0, 500); break
      case 'priority': out.priorityName = list[0]; break
      case 'labels': for (const l of list) { const s = sanitizeLabel(l); if (s) out.labels.push(s) } break
      case 'components': out.componentNames.push(...list); break
      case 'dueDate': { const t = Date.parse(list[0]); if (!Number.isNaN(t)) out.dueDate = new Date(t).toISOString(); break }
      case 'assignee': out.assigneeEmail = list[0].toLowerCase(); break
      case 'customField':
        if (f.mapping.customFieldId) out.customFields.push({ customFieldId: f.mapping.customFieldId, value: Array.isArray(v) ? list.join(', ') : v })
        break
    }
  }
  out.labels = [...new Set(out.labels)].slice(0, 20)
  out.componentNames = [...new Set(out.componentNames)].slice(0, 20)
  return out
}
