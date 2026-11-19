import { describe, test, expect } from 'bun:test'
import { suggestProjectKey, slugify, isValidProjectKey, validateWizard, TEMPLATE_OPTIONS } from '../lib/desk-wizard'

describe('service desk wizard helpers', () => {
  test('project key suggestion follows the server rule', () => {
    expect(suggestProjectKey('IT Support Desk')).toBe('ISD')
    expect(suggestProjectKey('Facilities')).toBe('FACI')
    expect(suggestProjectKey('HR')).toBe('HR')
    expect(suggestProjectKey('x')).toBe('XX')
    expect(suggestProjectKey('')).toBe('')
    for (const n of ['IT Support', 'Kundenservice Süd', 'a b c d e f g h', 'Ünïcode Désk', '2nd line', '123 Help']) {
      const k = suggestProjectKey(n)
      if (k) expect(isValidProjectKey(k)).toBe(true)
    }
  })
  test('slugify', () => {
    expect(slugify('IT Support Desk!')).toBe('it-support-desk')
    expect(slugify('  --Hello__World-- ')).toBe('hello-world')
    expect(slugify('!')).toBe('')
  })
  test('validation messages', () => {
    expect(validateWizard({ name: '', key: 'ab', slug: 'x', mode: 'new', existingKey: '' })).toEqual({
      name: 'Enter a name', key: 'Use 2 to 10 capital letters or digits, starting with a letter', slug: 'Use lower-case letters, digits and dashes (at least 2 characters)',
    })
    expect(validateWizard({ name: 'Help', key: 'HELP', slug: 'help', mode: 'new', existingKey: '' })).toEqual({})
    expect(validateWizard({ name: 'Help', key: '', slug: 'help', mode: 'existing', existingKey: '' })).toEqual({ existingKey: 'Choose a project' })
    expect(validateWizard({ name: 'Help', key: '', slug: 'help', mode: 'existing', existingKey: 'TEST' })).toEqual({})
  })
  test('templates match the API enum', () => {
    expect(TEMPLATE_OPTIONS.map((t) => t.id)).toEqual(['it-support', 'customer-service', 'hr', 'facilities', 'none'])
  })
})

describe('module templates in the wizard', () => {
  const extra = [{ id: 'itsm', title: 'IT service management', description: 'Incidents, problems, changes' }]
  test('a licensed module template is offered before Blank', async () => {
    const { mergeTemplateOptions, TEMPLATE_OPTIONS } = await import('../lib/desk-wizard')
    const ids = mergeTemplateOptions(TEMPLATE_OPTIONS, extra).map((t) => t.id)
    expect(ids.indexOf('itsm')).toBe(ids.indexOf('none') - 1)
  })
  test('nothing changes without extras; bad or duplicate ids are ignored', async () => {
    const { mergeTemplateOptions, TEMPLATE_OPTIONS } = await import('../lib/desk-wizard')
    expect(mergeTemplateOptions(TEMPLATE_OPTIONS, undefined)).toEqual(TEMPLATE_OPTIONS)
    const merged = mergeTemplateOptions(TEMPLATE_OPTIONS, [{ id: 'it-support', title: 'x', description: 'x' }, { id: 'Bad Id', title: 'x', description: 'x' }, ...extra])
    expect(merged.map((t) => t.id).filter((i) => i === 'it-support' || i === 'itsm')).toEqual(['it-support', 'itsm'])
    expect(merged).toHaveLength(TEMPLATE_OPTIONS.length + 1)
  })
})
