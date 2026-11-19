import { describe, test, expect } from 'bun:test'
import { accentCss, accentTokens, checkAccent, contrastRatio, editionLabel, footerText, isHexColor, pageTitle, showCredit } from '../lib/branding'
import { footerLinks } from '../components/product-footer'
import { ADMIN_LINKS } from '../lib/routes'

describe('hex validation and contrast', () => {
  test('accepts only #rrggbb', () => {
    expect(isHexColor('#3D6AF0')).toBe(true)
    expect(isHexColor('#3d6af0')).toBe(true)
    for (const bad of ['3D6AF0', '#fff', 'blue', '#12345', '#GGGGGG', '', null, undefined, 'red;}body{']) expect(isHexColor(bad as any)).toBe(false)
  })
  test('refuses colours below 3:1 on white', () => {
    expect(checkAccent('#2D54D8')).toBeNull()
    expect(checkAccent('#767676')).toBeNull()
    expect(checkAccent('#FFFF00')).toMatch(/Too light/)
    expect(checkAccent('#CCCCCC')).toMatch(/Too light/)
    expect(checkAccent('nope')).toMatch(/hex/)
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0)
  })
})

describe('accent tokens', () => {
  test('default look produces no CSS; an invalid colour is ignored', () => {
    expect(accentCss(null)).toBe('')
    expect(accentCss('red;}body{display:none')).toBe('')
  })
  test('overrides every brand step for light and dark and keeps buttons readable', () => {
    const { light, dark } = accentTokens('#1D4ED8')
    for (const n of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      expect(light[`--brand-${n}`]).toMatch(/^#[0-9A-F]{6}$/)
      expect(dark[`--brand-${n}`]).toMatch(/^#[0-9A-F]{6}$/)
    }
    expect(light['--brand-500']).toBe('#1D4ED8')
    expect(contrastRatio(light['--button-primary'], '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(dark['--brand-500'], '#1B1C1E')).toBeGreaterThanOrEqual(4.5)
    const css = accentCss('#1D4ED8')
    expect(css).toContain(':root{')
    expect(css).toContain('.dark{')
    expect(css).not.toContain('<')
  })
})

describe('footer text and links', () => {
  const base = { siteName: 'Veqsio', version: '1.2.3', build: 'abc123', hideCredit: false }
  test('product, version, build and edition', () => {
    expect(footerText({ ...base, license: { state: 'none', plan: 'community' } })).toBe('Veqsio 1.2.3 · build abc123 · Community')
    expect(footerText({ ...base, license: { state: 'valid', plan: 'enterprise' } })).toBe('Veqsio 1.2.3 · build abc123 · Enterprise')
    expect(footerText({ ...base, build: '', license: null })).toBe('Veqsio 1.2.3 · build dev')
    expect(footerText({ ...base, siteName: 'Acme Tracker', license: null })).toStartWith('Acme Tracker 1.2.3')
  })
  test('licence states', () => {
    expect(editionLabel({ state: 'grace', plan: 'enterprise' })).toMatch(/grace/)
    expect(editionLabel({ state: 'expired', plan: 'enterprise' })).toMatch(/expired/)
    expect(editionLabel({ state: 'invalid', plan: 'community' })).toMatch(/invalid/)
    expect(editionLabel({ state: 'valid', plan: 'team' })).toBe('Team')
  })
  test('docs and API links default to the website, support to the repository issues, all can be overridden', () => {
    const l = footerLinks({ docsUrl: null, supportUrl: null, sourceUrl: 'https://example.org/repo/' })
    expect(l.docs).toBe('https://veqsio.com/docs')
    expect(l.api).toBe('https://veqsio.com/docs/integrations-api')
    expect(l.support).toBe('https://example.org/repo/issues')
    expect(footerLinks({ docsUrl: 'https://d.test', supportUrl: 'https://s.test', sourceUrl: 'https://x' })).toMatchObject({ docs: 'https://d.test', support: 'https://s.test' })
  })
  test('credit and titles', () => {
    expect(showCredit(false)).toBe(true)
    expect(showCredit(true)).toBe(false)
    expect(pageTitle('Acme', 'Boards')).toBe('Boards · Acme')
    expect(pageTitle('Acme')).toBe('Acme')
  })
  test('the Appearance page is in the administration menu', () => {
    expect(ADMIN_LINKS.some((l) => l.href === '/admin/appearance')).toBe(true)
  })
})
