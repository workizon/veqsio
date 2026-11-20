import { describe, expect, test } from 'bun:test'
import { moduleI18n } from './i18n'

describe('moduleI18n', () => {
  test('module dictionary, then host dictionary, then the English text', () => {
    moduleI18n.register('demo', { de: { 'New plan': 'Neuer Plan' } })
    moduleI18n.setHost('de', (t) => (t === 'Save' ? 'Speichern' : t))
    expect(moduleI18n.translate('demo', 'New plan')).toBe('Neuer Plan')
    expect(moduleI18n.translate('demo', 'Save')).toBe('Speichern')
    expect(moduleI18n.translate('demo', 'Nobody translated this')).toBe('Nobody translated this')
    moduleI18n.setHost('en', (t) => t)
    expect(moduleI18n.translate('demo', 'New plan')).toBe('New plan')
  })
  test('subscribers are told when the language changes', () => {
    let n = 0
    const off = moduleI18n.subscribe(() => n++)
    const v = moduleI18n.getVersion()
    moduleI18n.setHost('ru', (t) => t)
    expect(n).toBe(1); expect(moduleI18n.getVersion()).toBe(v + 1)
    off(); moduleI18n.setHost('en', (t) => t); expect(n).toBe(1)
  })
})
