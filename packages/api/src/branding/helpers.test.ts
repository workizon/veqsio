import { describe, expect, test } from 'bun:test'
import { checkAccentColor, cleanUrl, contrastRatio, isHexColor, sniffImage, MAX_FILE_BYTES } from './helpers'

const enc = (s: string) => new TextEncoder().encode(s)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('branding helpers', () => {
  test('hex colours', () => {
    expect(isHexColor('#3D6AF0')).toBe(true)
    expect(isHexColor('#fff')).toBe(false)
    expect(isHexColor('red')).toBe(false)
    expect(isHexColor('#12345g')).toBe(false)
  })
  test('contrast on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(checkAccentColor('#2D54D8')).toBeNull()
    expect(checkAccentColor('#FFFF00')).toMatch(/too light/)
    expect(checkAccentColor('#cccccc')).toMatch(/too light/)
    expect(checkAccentColor('blue')).toMatch(/hex/)
  })
  test('urls', () => {
    expect(cleanUrl('https://docs.example.com/x')).toBe('https://docs.example.com/x')
    expect(cleanUrl('')).toBeNull()
    expect(cleanUrl('javascript:alert(1)')).toBeUndefined()
    expect(cleanUrl('data:text/html,x')).toBeUndefined()
    expect(cleanUrl('not a url')).toBeUndefined()
  })
  test('images are identified by content', () => {
    expect(sniffImage(PNG, 'light')).toEqual({ ok: true, kind: { mime: 'image/png', ext: 'png' } })
    expect(sniffImage(enc('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), 'dark').ok).toBe(true)
    expect(sniffImage(enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'), 'light').ok).toBe(true)
    expect(sniffImage(new Uint8Array([0, 0, 1, 0, 1, 0]), 'favicon').ok).toBe(true)
    expect(sniffImage(new Uint8Array([0, 0, 1, 0, 1, 0]), 'light').ok).toBe(false)
    expect(sniffImage(enc('<html><svg></svg></html>'), 'light').ok).toBe(false)
    expect(sniffImage(new Uint8Array(0), 'light').ok).toBe(false)
    expect(sniffImage(new Uint8Array(MAX_FILE_BYTES + 1), 'light').ok).toBe(false)
  })
  test('active SVG content is refused', () => {
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>',
    ]) expect(sniffImage(enc(bad), 'light').ok).toBe(false)
  })
})
