/** Pure helpers behind the label picker (filtering, create-on-type, keyboard cursor). */

export interface PickerOption {
  name: string
  color?: string | null
  issueCount?: number
}

export type PickerRow =
  | { kind: 'option'; option: PickerOption }
  | { kind: 'create'; name: string }

const MAX_LEN = 100

/** Jira style: no spaces or commas inside a label. Returns '' when nothing usable is left. */
export function normalizeNewLabel(input: string): string {
  return input.trim().replace(/[\s,]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_LEN)
}

/**
 * Rows for the listbox: matching existing labels (prefix matches first, already selected ones hidden),
 * then a "Create" row when the typed name does not exist yet.
 */
export function buildPickerRows(options: PickerOption[], selected: string[], query: string): PickerRow[] {
  const chosen = new Set(selected.map((s) => s.toLowerCase()))
  const q = query.trim().toLowerCase()
  const matches = options
    .filter((o) => !chosen.has(o.name.toLowerCase()))
    .filter((o) => !q || o.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
      return ap - bp || (b.issueCount ?? 0) - (a.issueCount ?? 0) || a.name.localeCompare(b.name)
    })
  const rows: PickerRow[] = matches.slice(0, 50).map((option) => ({ kind: 'option', option }))
  const candidate = normalizeNewLabel(query)
  if (candidate) {
    const exists = options.some((o) => o.name.toLowerCase() === candidate.toLowerCase()) || chosen.has(candidate.toLowerCase())
    if (!exists) rows.push({ kind: 'create', name: candidate })
  }
  return rows
}

/** Moves the highlighted row with wrap-around; returns -1 for an empty list. */
export function moveCursor(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1
  if (current < 0) return delta === 1 ? 0 : length - 1
  return (current + delta + length) % length
}

/** Adds a label unless it is already present (case-insensitive). */
export function addLabel(current: string[], name: string): string[] {
  const n = normalizeNewLabel(name)
  if (!n) return current
  if (current.some((c) => c.toLowerCase() === n.toLowerCase())) return current
  return [...current, n]
}
