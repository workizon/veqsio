import { describe, it, expect } from 'bun:test'
import { validateBoardConfig, CARD_COLOUR_TOKENS } from './board-config'

const ok = (jql: string) => (jql.includes('???') ? 'Unexpected token' : null)

describe('validateBoardConfig', () => {
  it('accepts empty and legacy configs and keeps unknown keys', () => {
    expect(validateBoardConfig(undefined)).toEqual({ ok: true, config: {} })
    expect(validateBoardConfig({ swimlaneField: 'assignee', other: 1 })).toEqual({ ok: true, config: { swimlaneField: 'assignee', other: 1 } })
  })

  it('rejects non-objects and oversized configs', () => {
    expect(validateBoardConfig([])).toMatchObject({ ok: false })
    expect(validateBoardConfig('x')).toMatchObject({ ok: false })
    expect(validateBoardConfig({ blob: 'x'.repeat(30_000) })).toMatchObject({ ok: false })
  })

  it('checks the typed legacy keys', () => {
    expect(validateBoardConfig({ allowParallelSprints: 'no' })).toMatchObject({ ok: false })
    expect(validateBoardConfig({ swimlaneField: 5 })).toMatchObject({ ok: false })
  })

  it('accepts every colour mode and trims rules', () => {
    for (const by of ['none', 'priority', 'issuetype', 'assignee', 'label']) {
      expect(validateBoardConfig({ cardColour: { by } }, ok)).toEqual({ ok: true, config: { cardColour: { by, rules: [] } } })
    }
    const r = validateBoardConfig({ cardColour: { by: 'rules', rules: [{ name: ' Urgent ', jql: ' priority = High ', colour: 'red' }] } }, ok)
    expect(r).toEqual({ ok: true, config: { cardColour: { by: 'rules', rules: [{ name: 'Urgent', jql: 'priority = High', colour: 'red' }] } } })
  })

  it('rejects unknown modes and colours that are not palette tokens', () => {
    expect(validateBoardConfig({ cardColour: { by: 'sprint' } })).toMatchObject({ ok: false })
    const bad = validateBoardConfig({ cardColour: { by: 'rules', rules: [{ jql: 'a = b', colour: '#ff0000' }] } }, ok)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors[0]).toContain('colour must be one of')
    expect(CARD_COLOUR_TOKENS).toContain('red')
  })

  it('rejects rules without JQL, with invalid JQL, or too many of them', () => {
    expect(validateBoardConfig({ cardColour: { by: 'rules', rules: [{ jql: '  ', colour: 'red' }] } }, ok)).toMatchObject({ ok: false })
    const bad = validateBoardConfig({ cardColour: { by: 'rules', rules: [{ jql: 'x ??? y', colour: 'red' }] } }, ok)
    expect(bad).toMatchObject({ ok: false })
    if (!bad.ok) expect(bad.errors[0]).toContain('Rule 1: Unexpected token')
    const many = Array.from({ length: 11 }, () => ({ jql: 'a = b', colour: 'red' }))
    expect(validateBoardConfig({ cardColour: { by: 'rules', rules: many } }, ok)).toMatchObject({ ok: false })
  })

  it('needs at least one rule when colouring by rules', () => {
    expect(validateBoardConfig({ cardColour: { by: 'rules', rules: [] } }, ok)).toMatchObject({ ok: false })
  })

  it('validates card layout fields and size', () => {
    const r = validateBoardConfig({ cardFields: ['assignee', 'labels', 'labels'], cardSize: 'compact' })
    expect(r).toMatchObject({ ok: true, config: { cardFields: ['labels', 'assignee'], cardSize: 'compact' } })
    expect(validateBoardConfig({ cardFields: ['nope'] })).toMatchObject({ ok: false })
    expect(validateBoardConfig({ cardFields: 'labels' })).toMatchObject({ ok: false })
    expect(validateBoardConfig({ cardSize: 'huge' })).toMatchObject({ ok: false })
    expect(validateBoardConfig({ cardFields: [] })).toMatchObject({ ok: true, config: { cardFields: [] } })
  })
})
