import { useMemo, useState } from 'react'

export type SortDir = 'asc' | 'desc'

/** Case-insensitive, number-aware comparison for titles; empty values sort last. */
export function compareText(a: unknown, b: unknown): number {
  const x = a == null ? '' : String(a)
  const y = b == null ? '' : String(b)
  if (!x && y) return 1
  if (x && !y) return -1
  return x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true })
}

export function sortRows<T>(rows: T[], get: (row: T) => unknown, dir: SortDir | null): T[] {
  if (!dir) return rows
  const sorted = [...rows].sort((a, b) => compareText(get(a), get(b)))
  return dir === 'desc' ? sorted.reverse() : sorted
}

/**
 * Click-to-sort state for one column. First click sorts A-Z, second Z-A, third restores the original order.
 * Usage: const { dir, toggle, sort } = useTextSort(); sort(rows, (r) => r.name)
 */
export function useTextSort() {
  const [dir, setDir] = useState<SortDir | null>(null)
  const toggle = () => setDir((d) => (d === null ? 'asc' : d === 'asc' ? 'desc' : null))
  const sort = <T,>(rows: T[], get: (row: T) => unknown): T[] => sortRows(rows, get, dir)
  return { dir, toggle, sort }
}

export function useSortedRows<T>(rows: T[], get: (row: T) => unknown, dir: SortDir | null): T[] {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => sortRows(rows, get, dir), [rows, dir])
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Multi-column sort: click sorts by one column (A-Z, Z-A, off); Shift/Ctrl/Cmd+click adds it as the next key. */
/* ---------------------------------------------------------------------------------------------------------- */

export interface SortKey { col: string; dir: SortDir }

/** Pure state transition used by every table (and unit-tested). */
export function toggleSortKey(keys: SortKey[], col: string, additive: boolean): SortKey[] {
  const cur = keys.find((k) => k.col === col)
  const next = (d: SortDir | undefined): SortDir | null => (d === undefined ? 'asc' : d === 'asc' ? 'desc' : null)
  if (additive) {
    const n = next(cur?.dir)
    if (!cur) return [...keys, { col, dir: 'asc' }]
    return n ? keys.map((k) => (k.col === col ? { col, dir: n } : k)) : keys.filter((k) => k.col !== col)
  }
  // plain click: only this column; cycle when it is already the single sort key
  const single = keys.length === 1 && cur
  const n = single ? next(cur.dir) : 'asc'
  return n ? [{ col, dir: n }] : []
}

export function sortRowsMulti<T>(rows: T[], getters: Record<string, (row: T) => unknown>, keys: SortKey[]): T[] {
  const active = keys.filter((k) => getters[k.col])
  if (!active.length) return rows
  return [...rows].sort((a, b) => {
    for (const k of active) {
      const get = getters[k.col]
      const x = get(a)
      const y = get(b)
      // empty values stay last in both directions
      const xe = x == null || x === ''
      const ye = y == null || y === ''
      if (xe !== ye) return xe ? 1 : -1
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : x instanceof Date && y instanceof Date ? x.getTime() - y.getTime() : compareText(x, y)
      if (c !== 0) return k.dir === 'desc' ? -c : c
    }
    return 0
  })
}

export function useMultiSort() {
  const [keys, setKeys] = useState<SortKey[]>([])
  const toggle = (col: string, e?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) =>
    setKeys((k) => toggleSortKey(k, col, !!(e?.shiftKey || e?.ctrlKey || e?.metaKey)))
  const dirOf = (col: string): SortDir | null => keys.find((k) => k.col === col)?.dir ?? null
  /** 1-based priority, only shown when more than one column is sorted */
  const rankOf = (col: string): number | undefined => {
    const i = keys.findIndex((k) => k.col === col)
    return keys.length > 1 && i >= 0 ? i + 1 : undefined
  }
  const sort = <T,>(rows: T[], getters: Record<string, (row: T) => unknown>): T[] => sortRowsMulti(rows, getters, keys)
  const clear = () => setKeys([])
  /** spread into <SortableTh {...ms.th('name')}> */
  const th = (col: string) => ({ dir: dirOf(col), rank: rankOf(col), onToggle: (e: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => toggle(col, e) })
  return { keys, toggle, dirOf, rankOf, sort, clear, th }
}

/** `name:asc,email:desc` for the server-side `orderBy` query parameter of paged lists. */
export function orderByParam(keys: SortKey[]): string {
  return keys.map((k) => `${k.col}:${k.dir}`).join(',')
}
