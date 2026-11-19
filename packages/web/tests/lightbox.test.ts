import { describe, expect, test } from 'bun:test'
import { collectImages, stepIndex, swipeStep } from '../lib/lightbox'

describe('image viewer logic', () => {
  test('stepping wraps around both ways', () => {
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(1, 1, 3)).toBe(2)
    expect(stepIndex(0, 1, 1)).toBe(0)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })
  test('a swipe needs distance and must be mostly horizontal', () => {
    expect(swipeStep(-80, 5)).toBe(-1)
    expect(swipeStep(80, -10)).toBe(1)
    expect(swipeStep(30, 0)).toBe(0)
    expect(swipeStep(-60, 70)).toBe(0)
    expect(swipeStep(-60, 45)).toBe(0)
  })
  test('tiny images such as icons are left out', () => {
    const r = collectImages([{ src: 'a.png', alt: 'a', naturalWidth: 640 }, { src: 'icon.png', alt: '', naturalWidth: 16 }, { src: '', naturalWidth: 500 }])
    expect(r).toEqual([{ src: 'a.png', alt: 'a' }])
  })
})
