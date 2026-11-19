import { describe, test, expect } from 'bun:test'
import { classifyGesture, decideSwipe, followDistance } from '../lib/swipe'

describe('swipe rules', () => {
  test('a gesture is classified only after it moved a little, and only clearly sideways counts as a swipe', () => {
    expect(classifyGesture(4, 3)).toBeNull()
    expect(classifyGesture(30, 5)).toBe('horizontal')
    expect(classifyGesture(-30, 10)).toBe('horizontal')
    expect(classifyGesture(30, 25)).toBe('vertical')   // diagonal: the page scrolls
    expect(classifyGesture(3, 40)).toBe('vertical')
  })

  test('a long enough slow swipe counts, in both directions', () => {
    expect(decideSwipe({ dx: -120, dy: 6, width: 300, elapsedMs: 900 })).toBe('left')
    expect(decideSwipe({ dx: 120, dy: -6, width: 300, elapsedMs: 900 })).toBe('right')
    expect(decideSwipe({ dx: -60, dy: 0, width: 300, elapsedMs: 900 })).toBeNull()    // too short and too slow
    expect(decideSwipe({ dx: -85, dy: 0, width: 300, elapsedMs: 900 })).toBeNull()    // 30% of 300 is 90
    expect(decideSwipe({ dx: -91, dy: 0, width: 300, elapsedMs: 900 })).toBe('left')
  })

  test('a short but quick flick counts, a short slow drag does not', () => {
    expect(decideSwipe({ dx: -50, dy: 3, width: 300, elapsedMs: 80 })).toBe('left')
    expect(decideSwipe({ dx: -50, dy: 3, width: 300, elapsedMs: 400 })).toBeNull()
    expect(decideSwipe({ dx: -30, dy: 0, width: 300, elapsedMs: 20 })).toBeNull()      // quick, but under 40 px
  })

  test('vertical or diagonal gestures are never swipes', () => {
    expect(decideSwipe({ dx: -100, dy: 90, width: 300, elapsedMs: 200 })).toBeNull()
    expect(decideSwipe({ dx: 5, dy: 200, width: 300, elapsedMs: 200 })).toBeNull()
  })

  test('the card follows the finger, resists past the limit and stays put toward a side without an action', () => {
    expect(followDistance(-40, { hasLeft: true, hasRight: true, limit: 96 })).toBe(-40)
    expect(followDistance(200, { hasLeft: true, hasRight: true, limit: 96 })).toBeCloseTo(96 + 104 * 0.25)
    expect(followDistance(-50, { hasLeft: false, hasRight: true, limit: 96 })).toBe(0)
    expect(followDistance(50, { hasLeft: true, hasRight: false, limit: 96 })).toBe(0)
    expect(followDistance(0, { hasLeft: true, hasRight: true, limit: 96 })).toBe(0)
  })
})
