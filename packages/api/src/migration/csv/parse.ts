import Papa from 'papaparse'

export interface ParsedCsv {
  headers: string[]
  /** Each row is an array aligned with `headers` (Jira exports repeat headers, e.g. several "Labels" columns). */
  rows: string[][]
}

export const MAX_CSV_BYTES = 50 * 1024 * 1024
export const MAX_CSV_ROWS = 200_000

export function parseCsv(text: string): ParsedCsv {
  if (text.length > MAX_CSV_BYTES) throw new Error('CSV is larger than 50 MB')
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' })
  const data = res.data as string[][]
  if (data.length < 2) throw new Error('CSV must contain a header row and at least one data row')
  if (data.length - 1 > MAX_CSV_ROWS) throw new Error(`CSV has more than ${MAX_CSV_ROWS} rows`)
  const headers = data[0].map((h) => h.trim())
  if (headers.every((h) => !h)) throw new Error('CSV header row is empty')
  return { headers, rows: data.slice(1).map((r) => headers.map((_, i) => (r[i] ?? '').toString())) }
}

/* ---------------- Field mapping ---------------- */

export const TARGET_FIELDS = [
  'summary', 'issueKey', 'issueId', 'description', 'issueType', 'status', 'priority', 'resolution',
  'assignee', 'reporter', 'created', 'updated', 'resolved', 'dueDate',
  'labels', 'components', 'fixVersions', 'affectsVersions', 'parent', 'environment', 'originalEstimate', 'storyPoints', 'comment',
] as const
export type TargetField = (typeof TARGET_FIELDS)[number]

/** Targets that may be fed by several columns (Jira repeats the header for each value). */
export const MULTI_FIELDS: ReadonlySet<TargetField> = new Set<TargetField>(['labels', 'components', 'fixVersions', 'affectsVersions', 'comment'])

/** target field -> column indexes */
export type Mapping = Partial<Record<TargetField, number[]>>

const SYNONYMS: Record<TargetField, string[]> = {
  summary: ['summary', 'issue summary', 'title', 'task name', 'task title', 'name'],
  issueKey: ['issue key', 'key'],
  issueId: ['issue id', 'task id', 'id'],
  description: ['description', 'task description', 'task content', 'notes'],
  issueType: ['issue type', 'issuetype', 'type'],
  status: ['status', 'state', 'section/column'],
  priority: ['priority'],
  resolution: ['resolution'],
  assignee: ['assignee', 'assignee email', 'assigned to'],
  reporter: ['reporter', 'creator', 'created by'],
  created: ['created', 'created date', 'created at', 'date created'],
  updated: ['updated', 'updated date', 'last updated'],
  resolved: ['resolved', 'resolution date', 'resolved date', 'completed at', 'completed', 'date closed', 'closed at'],
  dueDate: ['due date', 'due', 'duedate', 'due on'],
  labels: ['labels', 'label', 'tags'],
  components: ['component/s', 'components', 'component'],
  fixVersions: ['fix version/s', 'fix versions', 'fix version'],
  affectsVersions: ['affects version/s', 'affects versions', 'affects version'],
  parent: ['parent', 'parent id', 'parent key', 'parent task', 'parent issue', 'epic link'],
  environment: ['environment'],
  originalEstimate: ['original estimate', 'original estimate (seconds)', 'time estimate', 'time estimated'],
  storyPoints: ['story points', 'story point estimate', 'custom field (story points)', 'custom field (story point estimate)', 'points', 'sprint points', 'estimate'],
  comment: ['comment', 'comments'],
}

/** Suggest a mapping from header names. Exact synonym match only, so nothing is guessed silently. */
export function suggestMapping(headers: string[]): Mapping {
  const mapping: Mapping = {}
  const norm = headers.map((h) => h.trim().toLowerCase())
  for (const target of TARGET_FIELDS) {
    const idx: number[] = []
    for (const syn of SYNONYMS[target]) {
      norm.forEach((h, i) => { if (h === syn && !idx.includes(i)) idx.push(i) })
      if (idx.length) break
    }
    if (idx.length) mapping[target] = MULTI_FIELDS.has(target) ? idx : [idx[0]]
  }
  // "Parent id" must win over plain "Parent"; "Issue key" over generic "Key" - handled by synonym order.
  return mapping
}

export function validateMapping(mapping: Mapping, columnCount: number): string[] {
  const errors: string[] = []
  if (!mapping.summary?.length) errors.push('Map a column to Summary (required)')
  for (const [field, idx] of Object.entries(mapping)) {
    if (!TARGET_FIELDS.includes(field as TargetField)) errors.push(`Unknown target field: ${field}`)
    if (!Array.isArray(idx) || idx.some((i) => !Number.isInteger(i) || i < 0 || i >= columnCount)) errors.push(`Invalid column index for ${field}`)
    else if (!MULTI_FIELDS.has(field as TargetField) && idx.length > 1) errors.push(`${field} accepts a single column`)
  }
  return errors
}

export function cell(row: string[], mapping: Mapping, field: TargetField): string | null {
  const idx = mapping[field]?.[0]
  if (idx === undefined) return null
  const v = row[idx]?.trim()
  return v ? v : null
}

export function cells(row: string[], mapping: Mapping, field: TargetField): string[] {
  const out: string[] = []
  for (const i of mapping[field] ?? []) {
    const v = row[i]?.trim()
    if (v) out.push(v)
  }
  return out
}

/** Multi-value text such as "a, b; c" (single column) in addition to repeated columns. */
export function splitList(values: string[]): string[] {
  return [...new Set(values.flatMap((v) => v.split(/[,;]/)).map((v) => v.trim()).filter(Boolean))]
}

/* ---------------- Dates ---------------- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export type NumericDateOrder = 'dmy' | 'mdy'

function build(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date | null {
  const dt = new Date(Date.UTC(y, mo, d, h, mi, s))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d ? dt : null
}

function hour12(h: number, ampm?: string): number {
  if (!ampm) return h
  const pm = ampm.toLowerCase() === 'pm'
  return (h % 12) + (pm ? 12 : 0)
}

/** Parses ISO, Jira "15/Mar/23 2:30 PM", "15/Mar/2023", "15.03.2023 14:30", "03/15/2023" (with order option). */
export function parseDate(input: string | null, order: NumericDateOrder = 'dmy'): Date | null {
  if (!input) return null
  const s = input.trim()
  if (!s) return null

  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s)
  if (m) {
    if (m[7]) {
      const d = new Date(s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
      return Number.isNaN(d.getTime()) ? null : d
    }
    return build(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
  }

  m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s)
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase())
    if (mo < 0) return null
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    return build(y, mo, +m[1], hour12(+(m[4] ?? 0), m[7]), +(m[5] ?? 0), +(m[6] ?? 0))
  }

  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s)
  if (m) {
    const dotted = s.includes('.')
    const [a, b] = [+m[1], +m[2]]
    const [day, month] = dotted || order === 'dmy' ? [a, b] : [b, a]
    return build(+m[3], month - 1, day, hour12(+(m[4] ?? 0), m[7]), +(m[5] ?? 0), +(m[6] ?? 0))
  }
  return null
}

/** Jira CSV comment cell: "dd/MMM/yy h:mm a;author;body". Falls back to the raw text. */
export function parseCommentCell(raw: string, order: NumericDateOrder = 'dmy'): { created: Date | null; author: string | null; body: string } {
  const first = raw.indexOf(';')
  const second = first >= 0 ? raw.indexOf(';', first + 1) : -1
  if (first > 0 && second > first) {
    const created = parseDate(raw.slice(0, first), order)
    if (created) return { created, author: raw.slice(first + 1, second).trim() || null, body: raw.slice(second + 1) }
  }
  return { created: null, author: null, body: raw }
}

/** "2d 4h", "3600" (seconds) -> seconds. */
export function parseDurationSeconds(input: string | null): number | null {
  if (!input) return null
  if (/^\d+$/.test(input)) return Number(input)
  const m = /^(?:(\d+)w)?\s*(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?$/i.exec(input.trim())
  if (!m || !m.slice(1).some(Boolean)) return null
  return (+(m[1] ?? 0)) * 144000 + (+(m[2] ?? 0)) * 28800 + (+(m[3] ?? 0)) * 3600 + (+(m[4] ?? 0)) * 60
}

/** "5", "3.5", "3,5" -> 0..1000 rounded to 2 decimals; anything else -> null. */
export function parseStoryPointsCell(input: string | null): number | null {
  if (!input) return null
  const s = input.trim().replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return n >= 0 && n <= 1000 ? Math.round(n * 100) / 100 : null
}
