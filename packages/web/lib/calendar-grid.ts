/** Pure helpers for the month calendar (UTC, weeks start on Monday). */

export interface CalendarDay { date: string; day: number; inMonth: boolean }

const pad = (n: number) => String(n).padStart(2, '0')
export const isoDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

/** Weeks (arrays of 7 days, Monday first) that cover `month` (0-11) of `year`; always 6 rows so the grid does not jump. */
export function monthGrid(year: number, month: number): CalendarDay[][] {
  const first = new Date(Date.UTC(year, month, 1))
  const offset = (first.getUTCDay() + 6) % 7
  const start = Date.UTC(year, month, 1 - offset)
  const weeks: CalendarDay[][] = []
  for (let w = 0; w < 6; w++) {
    const row: CalendarDay[] = []
    for (let d = 0; d < 7; d++) {
      const date = new Date(start + (w * 7 + d) * 86_400_000)
      row.push({ date: isoDate(date), day: date.getUTCDate(), inMonth: date.getUTCMonth() === month })
    }
    weeks.push(row)
  }
  return weeks
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const t = year * 12 + month + delta
  return { year: Math.floor(t / 12), month: ((t % 12) + 12) % 12 }
}

/** Date range (inclusive) shown by the grid, for the search query. */
export function gridRange(weeks: CalendarDay[][]): { from: string; to: string } {
  return { from: weeks[0][0].date, to: weeks[weeks.length - 1][6].date }
}

/** Groups items by the first 10 characters of their date string (YYYY-MM-DD). */
export function groupByDate<T>(items: T[], dateOf: (item: T) => string | null | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const d = dateOf(item)?.slice(0, 10)
    if (!d) continue
    ;(out.get(d) ?? out.set(d, []).get(d)!).push(item)
  }
  return out
}
