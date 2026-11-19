/**
 * Rules for a horizontal swipe on a card (touch only). Kept free of the DOM so they can be tested.
 *
 * A gesture first decides whether it is horizontal (a swipe) or vertical (the page scrolls): it is a swipe only when it moved
 * clearly more sideways than up or down. A swipe counts when it was long enough, or short but quick.
 */
export type SwipeDirection = 'left' | 'right'

export const SLOP_PX = 10          // movement before the gesture is classified
export const LOCK_RATIO = 1.5      // sideways must beat vertical by this factor to be a swipe
export const MIN_DISTANCE_PX = 72  // a slow swipe must travel at least this far (or 30% of the card, whichever is larger)
export const MIN_FRACTION = 0.3
export const QUICK_DISTANCE_PX = 40
export const QUICK_SPEED = 0.5     // px per millisecond

/** 'horizontal' or 'vertical' once the finger has moved enough to tell, otherwise null (keep watching). */
export function classifyGesture(dx: number, dy: number): 'horizontal' | 'vertical' | null {
  const ax = Math.abs(dx), ay = Math.abs(dy)
  if (Math.max(ax, ay) < SLOP_PX) return null
  return ax > ay * LOCK_RATIO ? 'horizontal' : 'vertical'
}

/** Which swipe, if any, a finished horizontal gesture is. Negative dx is a swipe to the left. */
export function decideSwipe(args: { dx: number; dy: number; width: number; elapsedMs: number }): SwipeDirection | null {
  const { dx, dy, width, elapsedMs } = args
  if (classifyGesture(dx, dy) !== 'horizontal') return null
  const distance = Math.abs(dx)
  const needed = Math.max(MIN_DISTANCE_PX, width * MIN_FRACTION)
  const quick = distance >= QUICK_DISTANCE_PX && elapsedMs > 0 && distance / elapsedMs >= QUICK_SPEED
  if (distance < needed && !quick) return null
  return dx < 0 ? 'left' : 'right'
}

/** How far the card follows the finger: it resists after `limit`, and does not move toward a side that has no action. */
export function followDistance(dx: number, opts: { hasLeft: boolean; hasRight: boolean; limit: number }): number {
  if (dx < 0 && !opts.hasLeft) return 0
  if (dx > 0 && !opts.hasRight) return 0
  const a = Math.abs(dx)
  const eased = a <= opts.limit ? a : opts.limit + (a - opts.limit) * 0.25
  return dx < 0 ? -eased : eased
}
