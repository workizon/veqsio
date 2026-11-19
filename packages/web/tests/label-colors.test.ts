import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  LABEL_TOKENS, LABEL_PALETTE, contrastRatio, customChipColors, resolveChipColors, labelChipProps, describeLabel,
  ensureContrast, isHexColor, isLabelToken, mix, paletteCssVariables,
} from '../lib/label-colors'

describe('contrast maths', () => {
  test('black on white is 21:1 and identical colours are 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
  })
  test('mix interpolates', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#ff0000', '#ff0000', 0.3)).toBe('#ff0000')
  })
  test('ensureContrast darkens until AA is reached', () => {
    const out = ensureContrast('#9ec5fe', '#ffffff', 4.5, '#000000')
    expect(contrastRatio(out, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })
})

describe('palette', () => {
  test('has twelve tokens, each defined for both themes', () => {
    expect(LABEL_TOKENS.length).toBe(12)
    for (const t of LABEL_TOKENS) {
      expect(LABEL_PALETTE[t].light.bg).toMatch(/^#[0-9A-F]{6}$/i)
      expect(LABEL_PALETTE[t].dark.fg).toMatch(/^#[0-9A-F]{6}$/i)
    }
  })
  test('chip text passes WCAG AA (4.5:1) in light and dark for every token', () => {
    for (const t of LABEL_TOKENS) {
      for (const theme of ['light', 'dark'] as const) {
        const c = LABEL_PALETTE[t][theme]
        expect(`${t}/${theme}/${contrastRatio(c.fg, c.bg) >= 4.5}`).toBe(`${t}/${theme}/true`)
      }
    }
  })
  test('the colour dot is visible against its chip (3:1 non-text contrast)', () => {
    for (const t of LABEL_TOKENS) {
      for (const theme of ['light', 'dark'] as const) {
        const c = LABEL_PALETTE[t][theme]
        expect(`${t}/${theme}/${contrastRatio(c.dot, c.bg) >= 3}`).toBe(`${t}/${theme}/true`)
      }
    }
  })
  test('globals.css defines the same variables as the TS palette', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8')
    for (const theme of ['light', 'dark'] as const) {
      for (const line of paletteCssVariables(theme).split('\n')) {
        expect(css).toContain(line.trim())
      }
    }
  })
})

describe('custom hex colours', () => {
  const samples = ['#ffff00', '#ffffff', '#000000', '#ff0000', '#00ff00', '#0000ff', '#12ab9c', '#fedcba', '#808080']
  test('always reach AA contrast for chip text in both themes', () => {
    for (const hex of samples) {
      for (const theme of ['light', 'dark'] as const) {
        const c = customChipColors(hex, theme)
        expect(`${hex}/${theme}/${contrastRatio(c.fg, c.bg) >= 4.5}`).toBe(`${hex}/${theme}/true`)
      }
    }
  })
  test('keeps the exact colour for the dot', () => {
    expect(customChipColors('#12ab9c', 'light').dot).toBe('#12ab9c')
  })
})

describe('resolution and chip props', () => {
  test('tokens, hex and empty values resolve', () => {
    expect(resolveChipColors('blue', 'light')).toEqual(LABEL_PALETTE.blue.light)
    expect(resolveChipColors(null, 'dark')).toEqual(LABEL_PALETTE.gray.dark)
    expect(resolveChipColors('nonsense', 'dark')).toEqual(LABEL_PALETTE.gray.dark)
    expect(resolveChipColors('#FF0000', 'light').dot).toBe('#ff0000')
  })
  test('labelChipProps maps tokens to classes and hex to inline variables', () => {
    expect(labelChipProps('teal')).toEqual({ className: 'label-chip label-chip--teal', custom: false })
    expect(labelChipProps(undefined).className).toBe('label-chip label-chip--gray')
    const custom = labelChipProps('#ff8800')
    expect(custom.className).toContain('label-chip--custom')
    expect(custom.style?.['--lcx-dot']).toBe('#ff8800')
    expect(custom.style?.['--lcx-fg-d']).toBeDefined()
  })
  test('type guards', () => {
    expect(isLabelToken('red')).toBe(true)
    expect(isLabelToken('mauve')).toBe(false)
    expect(isHexColor('#a1b2c3')).toBe(true)
    expect(isHexColor('#a1b2c')).toBe(false)
  })
  test('description names the colour and the flag so colour is not the only signal', () => {
    expect(describeLabel('bug', 'red')).toBe('bug (red)')
    expect(describeLabel('tmp', null, true)).toBe('tmp removed when the issue is resolved')
    expect(describeLabel('x', '#112233')).toContain('#112233')
  })
})
