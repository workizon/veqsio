/** Pure helpers for the roadmap timeline (day granularity, UTC). */

export const DAY = 86_400_000

export type Zoom = 'weeks' | 'months' | 'quarters'
export const PX_PER_DAY: Record<Zoom, number> = { weeks: 28, months: 8, quarters: 3 }

export const dayOf = (iso: string | Date): number => {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime()
  return Math.floor(t / DAY)
}
export const ymd = (day: number): string => new Date(day * DAY).toISOString().slice(0, 10)

export interface Item { key: string; start: string; end: string | null }

/** Visible window with padding; falls back to "today ± a few months" when nothing is dated. */
export function computeWindow(items: Item[], versions: Array<{ startDate: string | null; releaseDate: string | null }>, today = Date.now()): { startDay: number; endDay: number } {
  const days: number[] = [dayOf(new Date(today))]
  for (const i of items) { days.push(dayOf(i.start)); if (i.end) days.push(dayOf(i.end)) }
  for (const v of versions) { if (v.startDate) days.push(dayOf(v.startDate)); if (v.releaseDate) days.push(dayOf(v.releaseDate)) }
  const min = Math.min(...days)
  const max = Math.max(...days)
  return { startDay: min - 14, endDay: Math.max(max + 45, min + 90) }
}

export interface Bar { left: number; width: number; open: boolean }

/** Pixel geometry of a bar. Items without an end render as a one-week "open" bar. */
export function barGeometry(item: Item, startDay: number, ppd: number): Bar {
  const s = dayOf(item.start)
  const open = item.end === null
  const e = open ? s + 7 : Math.max(dayOf(item.end!), s)
  return { left: (s - startDay) * ppd, width: Math.max((e - s + 1) * ppd, 8), open }
}

export type DragMode = 'move' | 'resize-start' | 'resize-end'

/** New start/end days after dragging by `dx` pixels, snapped to whole days. Start never passes end. */
export function applyDrag(mode: DragMode, startDay: number, endDay: number, dx: number, ppd: number): { startDay: number; endDay: number } {
  const delta = Math.round(dx / ppd)
  if (mode === 'move') return { startDay: startDay + delta, endDay: endDay + delta }
  if (mode === 'resize-start') return { startDay: Math.min(startDay + delta, endDay), endDay }
  return { startDay, endDay: Math.max(endDay + delta, startDay) }
}

export interface Tick { x: number; label: string; major: boolean }

/** Header ticks: weeks (Mondays) for week zoom, month starts otherwise, quarter starts for quarter zoom. */
export function headerTicks(startDay: number, endDay: number, ppd: number, zoom: Zoom): Tick[] {
  const ticks: Tick[] = []
  for (let d = startDay; d <= endDay; d++) {
    const dt = new Date(d * DAY)
    const dom = dt.getUTCDate()
    const month = dt.getUTCMonth()
    if (zoom === 'weeks') {
      if (dt.getUTCDay() === 1) ticks.push({ x: (d - startDay) * ppd, label: `${dom} ${MONTHS[month]}`, major: dom <= 7 })
    } else if (dom === 1) {
      if (zoom === 'quarters' && month % 3 !== 0) continue
      const label = zoom === 'quarters' ? `Q${month / 3 + 1} ${dt.getUTCFullYear()}` : `${MONTHS[month]} ${dt.getUTCFullYear()}`
      ticks.push({ x: (d - startDay) * ppd, label, major: month === 0 })
    }
  }
  return ticks
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
