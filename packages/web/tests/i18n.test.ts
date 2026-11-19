import { describe, test, expect } from 'bun:test'
import { DICTIONARIES, LOCALES, matchLocale, resolveLocale, translate, isLocale } from '../lib/i18n'
import { NAV_GROUPS, ADMIN_LINKS, ADMIN_SETTINGS } from '../lib/routes'
import { adminSections } from '../lib/admin-nav'

describe('i18n', () => {
  test('translate falls back to the English text', () => {
    expect(translate('en', 'Create issue')).toBe('Create issue')
    expect(translate('de', 'Create issue')).toBe('Vorgang erstellen')
    expect(translate('ru', 'A string nobody translated')).toBe('A string nobody translated')
  })
  test('locale resolution: own choice, instance default, browser, English', () => {
    expect(resolveLocale('ru', 'de', 'es-ES')).toBe('ru')
    expect(resolveLocale(null, 'de', 'es-ES')).toBe('de')
    expect(resolveLocale(null, 'en', 'es-ES')).toBe('es')
    expect(resolveLocale(null, 'en', 'fr-FR')).toBe('en')
    expect(resolveLocale('xx', 'zz', null)).toBe('en')
    expect(matchLocale('de-AT')).toBe('de')
    expect(isLocale('ru')).toBe(true)
    expect(isLocale('klingon')).toBe(false)
  })
  test('dictionaries have no empty values and keep the same placeholders', () => {
    for (const [id, dict] of Object.entries(DICTIONARIES)) {
      for (const [en, tr] of Object.entries(dict)) {
        expect(tr.trim().length, `${id}: ${en}`).toBeGreaterThan(0)
        expect((tr.match(/\{[a-zA-Z]+\}/g) ?? []).sort(), `${id}: ${en}`).toEqual((en.match(/\{[a-zA-Z]+\}/g) ?? []).sort())
      }
    }
    expect(LOCALES.map((l) => l.id)).toEqual(['en', ...Object.keys(DICTIONARIES)])
  })
  test('every navigation and administration label is translated in every language', () => {
    const labels = new Set<string>()
    for (const g of NAV_GROUPS) { labels.add(g.label); for (const i of g.items ?? []) labels.add(i.label) }
    for (const l of [...ADMIN_LINKS, ...ADMIN_SETTINGS]) if (l.href !== '/settings') labels.add(l.label)
    for (const s of adminSections()) { labels.add(s.title); for (const i of s.items) labels.add(i.label) }
    for (const [id, dict] of Object.entries(DICTIONARIES)) {
      const missing = [...labels].filter((l) => !(l in dict))
      expect(missing, `${id} lacks: ${missing.join(', ')}`).toEqual([])
    }
  })
})
