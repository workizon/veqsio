import { describe, test, expect } from 'bun:test'
import { EMPTY_FORM, PRESETS, formToMapping, mappingToForm } from '../lib/inbound-mapping'

describe('inbound mapping form', () => {
  test('round trips every preset', () => {
    for (const p of PRESETS) {
      const back = formToMapping(mappingToForm(p.mapping))
      expect('mapping' in back).toBe(true)
      if ('mapping' in back) expect(back.mapping).toEqual(p.mapping)
    }
  })
  test('empty form gives an empty mapping', () => {
    expect(formToMapping(EMPTY_FORM)).toEqual({ mapping: {} })
  })
  test('priority map lines are parsed, lower-cased and validated', () => {
    const ok = formToMapping({ ...EMPTY_FORM, priorityMap: 'Critical = Highest\nwarning=High' })
    expect(ok).toEqual({ mapping: { priorityMap: { critical: 'Highest', warning: 'High' } } })
    expect('error' in formToMapping({ ...EMPTY_FORM, priorityMap: 'nonsense' })).toBe(true)
    expect('error' in formToMapping({ ...EMPTY_FORM, priorityMap: 'a=' })).toBe(true)
  })
  test('resolved detection needs both parts; single value stays a string', () => {
    expect('error' in formToMapping({ ...EMPTY_FORM, resolvedPath: 'status' })).toBe(true)
    expect('error' in formToMapping({ ...EMPTY_FORM, resolvedEquals: 'ok' })).toBe(true)
    expect(formToMapping({ ...EMPTY_FORM, resolvedPath: 'status', resolvedEquals: 'resolved' })).toEqual({ mapping: { resolvedWhen: { path: 'status', equals: 'resolved' } } })
    expect(formToMapping({ ...EMPTY_FORM, resolvedPath: 'status', resolvedEquals: 'ok, resolved' })).toEqual({ mapping: { resolvedWhen: { path: 'status', equals: ['ok', 'resolved'] } } })
  })
  test('presets have valid sample payloads', () => {
    for (const p of PRESETS) expect(() => JSON.stringify(p.sample)).not.toThrow()
    expect(PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(['generic', 'grafana', 'github', 'sentry']))
  })
})
