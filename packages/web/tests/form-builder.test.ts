import { describe, test, expect } from 'bun:test'
import {
  makeKey, newField, insertField, moveField, removeField, duplicateField, renameKey, patchField, conditionCandidates,
  allowedMappings, parseOptions, checkForm, hasProblems, PALETTE,
} from '../lib/form-builder'
import { evaluateCondition, visibleKeys, initialValues, submittableValues, validateValues, type FieldDef } from '../lib/request-form'

const f = (key: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: key.toUpperCase(), type: 'text', ...extra })

describe('field keys', () => {
  test('derives camelCase keys and keeps them unique and safe', () => {
    expect(makeKey('Serial number', [])).toBe('serialNumber')
    expect(makeKey('Serial number', ['serialNumber'])).toBe('serialNumber2')
    expect(makeKey('  1st choice!  ', [])).toBe('stChoice')
    expect(makeKey('???', [])).toBe('field')
    expect(makeKey('constructor', [])).toBe('field')
    expect(makeKey('x'.repeat(80), []).length).toBeLessThanOrEqual(50)
  })
  test('every palette type yields a field that passes the form check', () => {
    let fields: FieldDef[] = []
    for (const p of PALETTE) fields = insertField(fields, newField(p.type, fields))
    expect(fields.length).toBe(PALETTE.length)
    expect(hasProblems(checkForm(fields))).toBe(false)
    expect(new Set(fields.map((x) => x.key)).size).toBe(fields.length)
  })
})

describe('ordering', () => {
  const base = [f('a'), f('b'), f('c')]
  test('move up/down/to', () => {
    expect(moveField(base, 2, 0).map((x) => x.key)).toEqual(['c', 'a', 'b'])
    expect(moveField(base, 0, 1).map((x) => x.key)).toEqual(['b', 'a', 'c'])
    expect(moveField(base, 0, 99).map((x) => x.key)).toEqual(['b', 'c', 'a'])
    expect(moveField(base, 1, 1)).toBe(base)
    expect(moveField(base, 5, 0)).toBe(base)
  })
  test('insert is clamped and immutable', () => {
    expect(insertField(base, f('z'), 1).map((x) => x.key)).toEqual(['a', 'z', 'b', 'c'])
    expect(insertField(base, f('z'), -4)[0].key).toBe('z')
    expect(base.length).toBe(3)
  })
  test('duplicate gets a new key and label right below', () => {
    const d = duplicateField(base, 0)
    expect(d.map((x) => x.key)).toEqual(['a', 'aCopy', 'b', 'c'])
    expect(d[1].label).toBe('A (copy)')
  })
  test('removing a field drops conditions that referred to it', () => {
    const fields = [f('a'), f('b', { visibleWhen: { field: 'a', value: 'x' } })]
    expect(removeField(fields, 0)[0].visibleWhen).toBeUndefined()
  })
  test('renaming a key updates conditions', () => {
    const fields = [f('a'), f('b', { visibleWhen: { field: 'a', value: 'x' } })]
    const r = renameKey(fields, 0, 'alpha')
    expect(r[1].visibleWhen?.field).toBe('alpha')
  })
  test('patch removes cleared properties', () => {
    const p = patchField([f('a', { helpText: 'h' })], 0, { helpText: undefined })
    expect('helpText' in p[0]).toBe(false)
  })
  test('condition candidates are value fields above', () => {
    const fields = [f('a'), f('s', { type: 'section' }), f('up', { type: 'attachment' }), f('b'), f('c')]
    expect(conditionCandidates(fields, 4).map((x) => x.key)).toEqual(['a', 'b'])
    expect(conditionCandidates(fields, 0)).toEqual([])
  })
})

describe('mapping rules and form checks', () => {
  test('allowed mappings per type', () => {
    expect(allowedMappings('text')).toContain('summary')
    expect(allowedMappings('textarea')).not.toContain('summary')
    expect(allowedMappings('date')).toContain('dueDate')
    expect(allowedMappings('user')).toContain('assignee')
    expect(allowedMappings('section')).toEqual(['none'])
    expect(allowedMappings('attachment')).toEqual(['none'])
  })
  test('reports problems per field', () => {
    const m = checkForm([
      f('a'), f('a'),
      f('b', { type: 'select' }),
      f('c', { visibleWhen: { field: 'later', value: 1 } }), f('later'),
      f('d', { validation: { pattern: '(' } }),
      f('e', { type: 'checkbox', mapping: { target: 'summary' } }),
      f('g', { mapping: { target: 'customField' } }),
      f('h', { mapping: { target: 'summary' } }), f('i', { mapping: { target: 'summary' } }),
    ])
    expect(m.get(1)?.join()).toContain('used twice')
    expect(m.get(2)?.join()).toContain('at least one option')
    expect(m.get(3)?.join()).toContain('above it')
    expect(m.get(5)?.join()).toContain('regular expression')
    expect(m.get(6)?.join()).toContain('cannot be mapped')
    expect(m.get(7)?.join()).toContain('custom field')
    expect(m.get(9)?.join()).toContain('already mapped')
  })
  test('parseOptions', () => {
    expect(parseOptions('a\n\n b , c \n')).toEqual(['a', 'b , c'])
  })
})

describe('portal form behaviour (shared with the preview)', () => {
  const fields: FieldDef[] = [
    f('kind', { type: 'select', options: ['hw', 'sw'], required: true }),
    f('serial', { required: true, visibleWhen: { field: 'kind', value: 'hw' }, validation: { minLength: 3 } }),
    f('qty', { type: 'number', validation: { min: 1, max: 5 }, defaultValue: 2 }),
    f('agent', { internal: true, defaultValue: 'x' }),
    f('head', { type: 'section' }),
    f('file', { type: 'attachment', required: true }),
  ]
  test('conditions and visibility', () => {
    expect(evaluateCondition({ field: 'kind', value: 'hw' }, { kind: 'hw' })).toBe(true)
    expect(evaluateCondition({ field: 'kind', op: 'notEquals', value: 'hw' }, {})).toBe(true)
    expect(evaluateCondition({ field: 'tags', value: 'a' }, { tags: ['a', 'b'] })).toBe(true)
    expect([...visibleKeys(fields, { kind: 'sw' })]).not.toContain('serial')
    expect([...visibleKeys(fields, { kind: 'hw' })]).toContain('serial')
  })
  test('defaults skip internal/layout/attachment; submission drops hidden and empty values', () => {
    expect(initialValues(fields)).toEqual({ qty: 2 })
    expect(submittableValues(fields, { kind: 'sw', serial: 'leftover', qty: 3, agent: 'hack', file: 'x' })).toEqual({ kind: 'sw', qty: 3 })
  })
  test('validation only for visible fields', () => {
    expect(validateValues(fields, { kind: 'sw' }, { file: [{}] })).toEqual({})
    expect(validateValues(fields, { kind: 'hw' }, { file: [{}] })).toEqual({ serial: 'SERIAL is required' })
    expect(validateValues(fields, { kind: 'hw', serial: 'ab', qty: 9 }, { file: [{}] })).toEqual({ serial: 'SERIAL must be at least 3 characters', qty: 'QTY must be at most 5' })
    expect(validateValues(fields, { kind: 'sw' })).toEqual({ file: 'FILE is required' })
    expect(validateValues([f('m', { type: 'email' })], { m: 'nope' }).m).toContain('email')
    expect(validateValues([f('u', { type: 'url' })], { u: 'javascript:x' }).u).toContain('URL')
  })
})
