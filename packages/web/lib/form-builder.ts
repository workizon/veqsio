/** Pure logic of the request form builder (no React): palette, adding/moving/removing fields, key generation, checks. */
import { isChoice, isLayout, type FieldDef, type FieldType, type MappingTarget } from './request-form'

export interface PaletteItem { type: FieldType; label: string; description: string }

export const PALETTE: PaletteItem[] = [
  { type: 'text', label: 'Short text', description: 'One line of text' },
  { type: 'textarea', label: 'Paragraph', description: 'Several lines of text' },
  { type: 'select', label: 'Select (single)', description: 'Pick one option from a list' },
  { type: 'multiselect', label: 'Multi-select', description: 'Pick several options from a list' },
  { type: 'checkboxes', label: 'Checkboxes', description: 'Tick any of the options' },
  { type: 'radio', label: 'Radio buttons', description: 'Pick exactly one visible option' },
  { type: 'checkbox', label: 'Single checkbox', description: 'Yes / no' },
  { type: 'date', label: 'Date', description: 'A calendar day' },
  { type: 'datetime', label: 'Date and time', description: 'A day and a time' },
  { type: 'number', label: 'Number', description: 'Numeric value' },
  { type: 'url', label: 'URL', description: 'A web address' },
  { type: 'email', label: 'Email', description: 'An email address' },
  { type: 'user', label: 'User picker', description: 'Someone known to this help center' },
  { type: 'attachment', label: 'Attachment', description: 'Files sent with the request' },
  { type: 'section', label: 'Section header', description: 'A heading between fields' },
  { type: 'help', label: 'Help text', description: 'Static text for the customer' },
]

export const typeLabel = (t: string) => PALETTE.find((p) => p.type === t)?.label ?? t

export const RESERVED_KEYS = new Set(['constructor', 'prototype', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'toLocaleString', 'valueOf', 'proto'])

/** `Serial number` -> `serialNumber`; always a valid, unused key (`field`, `field2`, ...). */
export function makeKey(label: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const words = label.normalize('NFKD').replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean)
  let base = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('')
  base = base.replace(/[^a-zA-Z0-9_]/g, '').replace(/^[^a-z]+/, '')
  if (!base || RESERVED_KEYS.has(base)) base = 'field'
  base = base.slice(0, 44)
  let key = base
  for (let n = 2; used.has(key) || RESERVED_KEYS.has(key); n++) key = `${base}${n}`
  return key
}

const DEFAULT_LABELS: Partial<Record<FieldType, string>> = { section: 'Section', help: 'Help' }

export function newField(type: FieldType, existing: FieldDef[]): FieldDef {
  const label = DEFAULT_LABELS[type] ?? typeLabel(type)
  const f: FieldDef = { key: makeKey(label, existing.map((e) => e.key)), label, type }
  if (isChoice(type)) f.options = ['Option 1', 'Option 2']
  if (type === 'help') f.helpText = 'Add some helpful text here.'
  return f
}

/** Insert at an index (clamped); returns a new array. */
export function insertField(fields: FieldDef[], field: FieldDef, index = fields.length): FieldDef[] {
  const i = Math.max(0, Math.min(index, fields.length))
  return [...fields.slice(0, i), field, ...fields.slice(i)]
}

export function moveField(fields: FieldDef[], from: number, to: number): FieldDef[] {
  if (from === to || from < 0 || from >= fields.length) return fields
  const t = Math.max(0, Math.min(to, fields.length - 1))
  const next = [...fields]
  const [f] = next.splice(from, 1)
  next.splice(t, 0, f)
  return next
}

/** Remove a field and drop conditions that referred to it. */
export function removeField(fields: FieldDef[], index: number): FieldDef[] {
  const key = fields[index]?.key
  return fields.filter((_, i) => i !== index).map((f) => (f.visibleWhen?.field === key ? { ...f, visibleWhen: undefined } : f))
}

export function duplicateField(fields: FieldDef[], index: number): FieldDef[] {
  const src = fields[index]
  if (!src) return fields
  const copy: FieldDef = { ...structuredClone(src), key: makeKey(`${src.label} copy`, fields.map((f) => f.key)), label: `${src.label} (copy)` }
  return insertField(fields, copy, index + 1)
}

/** Rename a key everywhere it is referenced (conditions). */
export function renameKey(fields: FieldDef[], index: number, newKey: string): FieldDef[] {
  const old = fields[index].key
  return fields.map((f, i) => {
    let next = f
    if (i === index) next = { ...next, key: newKey }
    if (f.visibleWhen?.field === old) next = { ...next, visibleWhen: { ...f.visibleWhen, field: newKey } }
    return next
  })
}

export function patchField(fields: FieldDef[], index: number, patch: Partial<FieldDef>): FieldDef[] {
  return fields.map((f, i) => {
    if (i !== index) return f
    const next: FieldDef = { ...f, ...patch }
    // drop keys explicitly cleared with undefined so they are not serialised
    for (const k of Object.keys(next) as Array<keyof FieldDef>) if (next[k] === undefined) delete next[k]
    return next
  })
}

/** Fields that a condition on `fields[index]` may refer to: value fields above it. */
export function conditionCandidates(fields: FieldDef[], index: number): FieldDef[] {
  return fields.slice(0, index).filter((f) => !isLayout(f.type) && f.type !== 'attachment')
}

/** Which issue fields a field type may be mapped to (mirrors the server). */
export function allowedMappings(type: string): MappingTarget[] {
  const out: MappingTarget[] = ['none']
  if (type === 'text') out.push('summary')
  if (type === 'text' || type === 'textarea') out.push('description')
  if (type === 'select' || type === 'radio') out.push('priority')
  if (['text', 'select', 'radio', 'multiselect', 'checkboxes'].includes(type)) out.push('labels')
  if (['select', 'radio', 'multiselect', 'checkboxes'].includes(type)) out.push('components')
  if (type === 'date' || type === 'datetime') out.push('dueDate')
  if (type === 'user') out.push('assignee')
  if (!isLayout(type) && type !== 'attachment') out.push('customField')
  return out
}

export const MAPPING_LABELS: Record<MappingTarget, string> = {
  none: 'Stored in request form only', summary: 'Summary', description: 'Description', priority: 'Priority', labels: 'Labels',
  components: 'Components', dueDate: 'Due date', assignee: 'Assignee', customField: 'Custom field',
}

/** `a, b\nc` -> ['a','b','c'] (one option per line; commas allowed inside an option). */
export const parseOptions = (text: string): string[] => text.split('\n').map((s) => s.trim()).filter(Boolean)

const KEY_RE = /^[a-z][a-zA-Z0-9_]{0,49}$/

/** Problems per field index (for inline display) plus form level ones under index -1. Mirrors validateFormDefinition on the server. */
export function checkForm(fields: FieldDef[]): Map<number, string[]> {
  const out = new Map<number, string[]>()
  const add = (i: number, msg: string) => out.set(i, [...(out.get(i) ?? []), msg])
  const seen = new Set<string>()
  const singles = new Set<string>()
  if (fields.length > 50) add(-1, 'A form can have at most 50 fields')
  fields.forEach((f, i) => {
    if (!f.label.trim()) add(i, 'Label is required')
    if (!KEY_RE.test(f.key) || RESERVED_KEYS.has(f.key)) add(i, `Field key "${f.key}" is not valid`)
    if (seen.has(f.key)) add(i, `Field key "${f.key}" is used twice`)
    seen.add(f.key)
    if (isChoice(f.type)) {
      const o = f.options ?? []
      if (o.length === 0) add(i, 'Add at least one option')
      if (new Set(o).size !== o.length) add(i, 'Options must be unique')
    }
    const v = f.validation
    if (v?.minLength != null && v.maxLength != null && v.minLength > v.maxLength) add(i, 'Minimum length exceeds maximum length')
    if (v?.min != null && v.max != null && v.min > v.max) add(i, 'Minimum exceeds maximum')
    if (v?.pattern) { try { new RegExp(v.pattern) } catch { add(i, 'The pattern is not a valid regular expression') } }
    if (f.visibleWhen) {
      const at = fields.findIndex((d) => d.key === f.visibleWhen!.field)
      if (at === -1) add(i, 'The condition refers to a field that does not exist')
      else if (at >= i) add(i, 'A condition can only refer to a field above it')
    }
    if (f.mapping) {
      const t = f.mapping.target
      if (!allowedMappings(f.type).includes(t)) add(i, `A ${typeLabel(f.type).toLowerCase()} cannot be mapped to ${MAPPING_LABELS[t].toLowerCase()}`)
      if (t === 'customField' && !f.mapping.customFieldId) add(i, 'Choose the custom field to map to')
      if (f.internal && (t === 'summary' || t === 'description')) add(i, 'Internal fields cannot map to summary or description')
      if (['summary', 'dueDate', 'assignee', 'priority'].includes(t)) {
        if (singles.has(t)) add(i, `Another field is already mapped to ${MAPPING_LABELS[t].toLowerCase()}`)
        singles.add(t)
      }
    }
  })
  return out
}

export const hasProblems = (m: Map<number, string[]>) => [...m.values()].some((v) => v.length > 0)
