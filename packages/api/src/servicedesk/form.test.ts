import { describe, test, expect } from 'bun:test'
import {
  validateFieldValues, validateFormDefinition, renderDescription, mapFieldValues, toPortalFields, visibleKeys,
  evaluateCondition, isSafeFieldKey, safePattern, hasMappedField, type FieldDef,
} from './form'

const ok = (r: ReturnType<typeof validateFieldValues>) => { if (!r.ok) throw new Error(r.errors.join('; ')); return r.values }
const errs = (r: ReturnType<typeof validateFieldValues>) => { if (r.ok) throw new Error('expected errors'); return r.errors }

describe('legacy request types keep working', () => {
  const defs: FieldDef[] = [
    { key: 'device', label: 'Device', type: 'select', required: true, options: ['Laptop', 'Phone'] },
    { key: 'urgent', label: 'Urgent', type: 'checkbox' },
    { key: 'count', label: 'Count', type: 'number' },
    { key: 'when', label: 'When', type: 'date' },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ]
  test('valid values, unknown keys dropped', () => {
    expect(ok(validateFieldValues(defs, { device: 'Laptop', urgent: true, count: 3, when: '2026-01-02', evil: 'x' }))).toEqual({ device: 'Laptop', urgent: true, count: 3, when: '2026-01-02' })
  })
  test('same errors as before', () => {
    expect(errs(validateFieldValues(defs, {}))).toEqual(['Device is required'])
    expect(errs(validateFieldValues(defs, { device: 'Tablet' }))).toEqual(['Device has an invalid option'])
    expect(errs(validateFieldValues(defs, { device: 'Laptop', count: '3' }))).toEqual(['Count must be a number'])
    expect(errs(validateFieldValues(defs, { device: 'Laptop', urgent: 'yes' }))).toEqual(['Urgent must be true/false'])
  })
  test('legacy description rendering', () => {
    expect(renderDescription(defs, { device: 'Laptop', urgent: false }, 'Body')).toBe('Body\n\n*Device*: Laptop\n\n*Urgent*: No')
  })
  test('legacy form passes definition validation', () => {
    expect(validateFormDefinition(defs)).toEqual([])
  })
})

describe('new field types', () => {
  const defs: FieldDef[] = [
    { key: 'site', label: 'Site', type: 'url' },
    { key: 'mail', label: 'Mail', type: 'email' },
    { key: 'tags', label: 'Tags', type: 'checkboxes', options: ['a', 'b', 'c'] },
    { key: 'multi', label: 'Multi', type: 'multiselect', options: ['x', 'y'], required: true },
    { key: 'size', label: 'Size', type: 'radio', options: ['S', 'M'] },
    { key: 'at', label: 'At', type: 'datetime' },
    { key: 'who', label: 'Who', type: 'user' },
    { key: 'head', label: 'Section', type: 'section' },
    { key: 'note', label: 'Note', type: 'help', helpText: 'Read me' },
    { key: 'file', label: 'File', type: 'attachment' },
  ]
  test('accepts valid values and drops layout/attachment', () => {
    const v = ok(validateFieldValues(defs, {
      site: 'https://example.com/x', mail: 'a@b.co', tags: ['a', 'c', 'a'], multi: ['x'], size: 'M', at: '2026-01-02T10:00:00Z',
      who: 'bob@example.com', head: 'x', note: 'y', file: 'z',
    }))
    expect(v).toEqual({ site: 'https://example.com/x', mail: 'a@b.co', tags: ['a', 'c'], multi: ['x'], size: 'M', at: '2026-01-02T10:00:00Z', who: 'bob@example.com' })
  })
  test('rejects bad values', () => {
    expect(errs(validateFieldValues(defs, { multi: ['x'], site: 'javascript:alert(1)' }))).toEqual(['Site must be a valid http(s) URL'])
    expect(errs(validateFieldValues(defs, { multi: ['x'], mail: 'nope' }))).toEqual(['Mail must be an email address'])
    expect(errs(validateFieldValues(defs, { multi: ['z'] }))).toEqual(['Multi has an invalid option'])
    expect(errs(validateFieldValues(defs, { multi: [] }))).toEqual(['Multi is required'])
    expect(errs(validateFieldValues(defs, { multi: 'x' }))).toEqual(['Multi has an invalid option'])
    expect(errs(validateFieldValues(defs, { multi: ['x'], size: 'L' }))).toEqual(['Size has an invalid option'])
  })
})

describe('validation rules', () => {
  const defs: FieldDef[] = [
    { key: 'code', label: 'Code', type: 'text', validation: { minLength: 3, maxLength: 6, pattern: '^[A-Z]+$' } },
    { key: 'qty', label: 'Qty', type: 'number', validation: { min: 1, max: 10 } },
  ]
  test('length, pattern, range', () => {
    expect(ok(validateFieldValues(defs, { code: 'ABCD', qty: 5 }))).toEqual({ code: 'ABCD', qty: 5 })
    expect(errs(validateFieldValues(defs, { code: 'AB' }))).toEqual(['Code must be at least 3 characters'])
    expect(errs(validateFieldValues(defs, { code: 'ABCDEFG' }))).toEqual(['Code must be at most 6 characters'])
    expect(errs(validateFieldValues(defs, { code: 'abcd' }))).toEqual(['Code has an invalid format'])
    expect(errs(validateFieldValues(defs, { qty: 0 }))).toEqual(['Qty must be at least 1'])
    expect(errs(validateFieldValues(defs, { qty: 11 }))).toEqual(['Qty must be at most 10'])
  })
})

describe('conditional visibility', () => {
  const defs: FieldDef[] = [
    { key: 'kind', label: 'Kind', type: 'select', options: ['hardware', 'software'], required: true },
    { key: 'serial', label: 'Serial', type: 'text', required: true, visibleWhen: { field: 'kind', value: 'hardware' } },
    { key: 'licence', label: 'Licence', type: 'text', visibleWhen: { field: 'kind', op: 'notEquals', value: 'hardware' } },
    { key: 'extra', label: 'Extra', type: 'text', required: true, visibleWhen: { field: 'serial', op: 'filled' } },
  ]
  test('hidden required fields do not block and their values are dropped', () => {
    expect(ok(validateFieldValues(defs, { kind: 'software', serial: 'SN1', licence: 'L-1' }))).toEqual({ kind: 'software', licence: 'L-1' })
  })
  test('visible required fields are enforced, cascade hides dependants', () => {
    expect(errs(validateFieldValues(defs, { kind: 'hardware' }))).toEqual(['Serial is required'])
    expect(errs(validateFieldValues(defs, { kind: 'hardware', serial: 'SN1' }))).toEqual(['Extra is required'])
    expect(ok(validateFieldValues(defs, { kind: 'hardware', serial: 'SN1', extra: 'e' }))).toEqual({ kind: 'hardware', serial: 'SN1', extra: 'e' })
  })
  test('operators and multi values', () => {
    expect(evaluateCondition({ field: 'a', op: 'in', value: ['x', 'y'] }, { a: 'y' })).toBe(true)
    expect(evaluateCondition({ field: 'a', value: 'x' }, { a: ['x', 'z'] })).toBe(true)
    expect(evaluateCondition({ field: 'a', value: true }, { a: true })).toBe(true)
    expect(evaluateCondition({ field: 'a', value: 'x' }, {})).toBe(false)
    expect(evaluateCondition({ field: 'a', op: 'notEquals', value: 'x' }, {})).toBe(true)
    expect([...visibleKeys(defs, { kind: 'hardware' })]).toEqual(['kind', 'serial'])
  })
  test('conditions cannot read the prototype chain', () => {
    expect(evaluateCondition({ field: 'constructor', op: 'filled' }, {})).toBe(false)
  })
})

describe('internal-only fields', () => {
  const defs: FieldDef[] = [
    { key: 'subject', label: 'Subject', type: 'text', required: true },
    { key: 'triage', label: 'Triage', type: 'select', options: ['p1', 'p2'], internal: true, required: true, defaultValue: 'p2', mapping: { target: 'labels' } },
    { key: 'secret', label: 'Secret note', type: 'text', internal: true },
  ]
  test('customer values are ignored; defaults apply; required is not enforced on customers', () => {
    expect(ok(validateFieldValues(defs, { subject: 's', triage: 'p1', secret: 'leak' }))).toEqual({ subject: 's', triage: 'p2' })
  })
  test('portal projection removes internal fields and mapping', () => {
    const p = toPortalFields([...defs, { key: 'dept', label: 'Dept', type: 'text', mapping: { target: 'customFieldId' as any } }])
    expect(p.map((f) => f.key)).toEqual(['subject', 'dept'])
    expect(JSON.stringify(p)).not.toContain('mapping')
    expect(JSON.stringify(p)).not.toContain('Triage')
  })
  test('internal values never render into the description', () => {
    expect(renderDescription(defs, { subject: 's', triage: 'p2', secret: 'x' })).toBe('*Subject*: s')
  })
})

describe('definition validation', () => {
  test('rejects duplicate/reserved keys, bad options, bad conditions and patterns', () => {
    const p = validateFormDefinition([
      { key: 'a', label: 'A', type: 'text' },
      { key: 'a', label: 'A2', type: 'text' },
      { key: 'constructor', label: 'C', type: 'text' },
      { key: 'sel', label: 'Sel', type: 'select' },
      { key: 'b', label: 'B', type: 'text', visibleWhen: { field: 'later', value: 'x' } },
      { key: 'later', label: 'Later', type: 'text' },
      { key: 'p', label: 'P', type: 'text', validation: { pattern: '(a+)+$' } },
      { key: 'n', label: 'N', type: 'text', validation: { min: 1 } },
    ])
    expect(p.join('|')).toContain('duplicate field key')
    expect(p.join('|')).toContain('invalid field key "constructor"')
    expect(p.join('|')).toContain('add at least one option')
    expect(p.join('|')).toContain('may only refer to a field above it')
    expect(p.join('|')).toContain('safe regular expression')
    expect(p.join('|')).toContain('number fields only')
  })
  test('mapping compatibility', () => {
    const p = validateFormDefinition([
      { key: 'a', label: 'A', type: 'checkbox', mapping: { target: 'summary' } },
      { key: 'b', label: 'B', type: 'text', mapping: { target: 'customField' } },
      { key: 'c', label: 'C', type: 'text', internal: true, mapping: { target: 'description' } },
      { key: 'd', label: 'D', type: 'text', mapping: { target: 'summary' } },
      { key: 'e', label: 'E', type: 'text', mapping: { target: 'summary' } },
      { key: 'f', label: 'F', type: 'section', required: true },
    ])
    const j = p.join('|')
    expect(j).toContain('cannot be mapped to summary')
    expect(j).toContain('choose the custom field')
    expect(j).toContain('internal fields cannot map to summary or description')
    expect(j).toContain('another field is already mapped to summary')
    expect(j).toContain('cannot be required')
  })
  test('default value must itself be valid', () => {
    expect(validateFormDefinition([{ key: 'a', label: 'A', type: 'select', options: ['x'], defaultValue: 'y' }]).join()).toContain('default value is invalid')
    expect(validateFormDefinition([{ key: 'a', label: 'A', type: 'select', options: ['x'], defaultValue: 'x' }])).toEqual([])
  })
  test('key and pattern helpers', () => {
    expect(isSafeFieldKey('__proto__')).toBe(false)
    expect(isSafeFieldKey('toString')).toBe(false)
    expect(isSafeFieldKey('orderNo')).toBe(true)
    expect(safePattern('^[a-z]+$')).toBeInstanceOf(RegExp)
    expect(safePattern('[')).toBeNull()
    expect(safePattern('x'.repeat(201))).toBeNull()
  })
})

describe('mapping into issue fields', () => {
  const defs: FieldDef[] = [
    { key: 'subj', label: 'Subject', type: 'text', mapping: { target: 'summary' } },
    { key: 'body', label: 'Body', type: 'textarea', mapping: { target: 'description' } },
    { key: 'prio', label: 'Priority', type: 'select', options: ['High', 'Low'], mapping: { target: 'priority' } },
    { key: 'tags', label: 'Tags', type: 'checkboxes', options: ['net work', 'x<y'], mapping: { target: 'labels' } },
    { key: 'comp', label: 'Component', type: 'select', options: ['UI'], mapping: { target: 'components' } },
    { key: 'due', label: 'Due', type: 'date', mapping: { target: 'dueDate' } },
    { key: 'who', label: 'Assignee', type: 'user', mapping: { target: 'assignee' } },
    { key: 'cf', label: 'CF', type: 'multiselect', options: ['a', 'b'], mapping: { target: 'customField', customFieldId: 7 } },
    { key: 'only', label: 'Only form', type: 'text', mapping: { target: 'none' } },
    { key: 'legacy', label: 'Legacy', type: 'text' },
  ]
  const values = {
    subj: '  Printer\n broken  ', body: 'It prints\r\nblank\u0000 pages', prio: 'High', tags: ['net work', 'x<y'], comp: 'UI',
    due: '2026-03-04', who: 'Bob@Example.com', cf: ['a', 'b'], only: 'private', legacy: 'visible',
  }
  test('maps targets', () => {
    expect(mapFieldValues(defs, values)).toEqual({
      summary: 'Printer broken', priorityName: 'High', labels: ['net-work', 'xy'], componentNames: ['UI'],
      dueDate: '2026-03-04T00:00:00.000Z', assigneeEmail: 'bob@example.com', customFields: [{ customFieldId: 7, value: 'a, b' }],
    })
  })
  test('description gets mapped body and legacy fields only; control chars stripped', () => {
    const d = renderDescription(defs, values, 'Intro')
    expect(d).toBe('Intro\n\nIt prints\nblank pages\n\n*Legacy*: visible')
    expect(d).not.toContain('private')
  })
  test('hasMappedField reflects customer-facing mappings only', () => {
    expect(hasMappedField(defs, 'summary')).toBe(true)
    expect(hasMappedField([{ key: 's', label: 'S', type: 'text', internal: true, mapping: { target: 'summary' } }], 'summary')).toBe(false)
  })
  test('field keys cannot pollute prototypes', () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x", "a": "ok"}')
    const r = validateFieldValues([{ key: 'a', label: 'A', type: 'text' }], evil)
    expect(ok(r)).toEqual({ a: 'ok' })
    expect(({} as any).polluted).toBeUndefined()
    expect(mapFieldValues([{ key: 'constructor', label: 'C', type: 'text', mapping: { target: 'labels' } }], {}).labels).toEqual([])
  })
})
