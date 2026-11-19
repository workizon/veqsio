/** Index maths and gesture decisions of the image viewer, kept apart from the component so that they can be tested. */

export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((index + delta) % count) + count) % count
}

/** A horizontal swipe of at least 48 px that is clearly more horizontal than vertical: -1 for a swipe left (next image), 1 for right (previous), 0 for anything else. */
export function swipeStep(dx: number, dy: number, minDistance = 48): -1 | 0 | 1 {
  if (Math.abs(dx) < minDistance || Math.abs(dx) < Math.abs(dy) * 1.5) return 0
  return dx < 0 ? -1 : 1
}

export interface LightboxImage { src: string; alt: string; downloadName?: string }

/** The images of a container that belong in a viewer (not tiny icons or emoji): those with a source and a size of at least 24 px once loaded. */
export function collectImages(imgs: Array<{ currentSrc?: string; src?: string; alt?: string; naturalWidth?: number; width?: number }>): LightboxImage[] {
  return imgs
    .filter((i) => (i.currentSrc || i.src) && (i.naturalWidth ?? i.width ?? 100) >= 24)
    .map((i) => ({ src: (i.currentSrc || i.src) as string, alt: i.alt ?? '' }))
}
