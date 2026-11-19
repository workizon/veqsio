/**
 * Server-side validation of gadget configuration and grid rectangles. Pure (no DB): JQL syntax is checked by the
 * caller because that needs the JQL engine's context.
 *
 * Built-in gadget types have a closed set of config keys (unknown keys are rejected); other types (plugins)
 * only need a well-formed type id and a small JSON object.
 */
import { z } from 'zod'

export const GROUP_FIELDS = [
  'status', 'statusCategory', 'priority', 'type', 'assignee', 'reporter', 'resolution', 'project',
  'component', 'labels', 'fixversion', 'createdMonth', 'resolvedMonth', 'dueMonth',
] as const
export type GroupField = (typeof GROUP_FIELDS)[number]

export const COLUMN_KEYS = ['key', 'summary', 'status', 'priority', 'type', 'assignee', 'reporter', 'created', 'updated', 'due', 'resolution', 'project'] as const

const idString = z.union([z.string().regex(/^\d{1,12}$/), z.number().int().nonnegative()]).transform((v) => String(v))
const optionalId = z.union([idString, z.literal('')]).optional()

/** Every config key a built-in gadget may use, with its type. */
const KEY_SCHEMAS = {
  title: z.string().max(200),
  jql: z.string().max(2000),
  filterId: optionalId,
  projectId: optionalId,
  boardId: optionalId,
  sprintId: optionalId,
  versionId: optionalId,
  deskId: optionalId,
  epicKey: z.string().max(100),
  period: z.enum(['daily', 'weekly', 'monthly']),
  count: z.number().int().min(1).max(90),
  days: z.number().int().min(1).max(365),
  limit: z.number().int().min(1).max(100),
  field: z.enum(GROUP_FIELDS),
  field2: z.enum(GROUP_FIELDS),
  metric: z.enum(['count', 'estimate', 'spent']),
  unit: z.enum(['issues', 'hours', 'points']),
  chart: z.enum(['donut', 'pie', 'bar', 'table']),
  sort: z.enum(['count', 'name']),
  dateField: z.enum(['created', 'resolved', 'updated', 'due']),
  mode: z.enum(['version', 'epic']),
  columns: z.array(z.enum(COLUMN_KEYS)).min(1).max(12),
  text: z.string().max(20000),
  showTable: z.boolean(),
  refresh: z.union([z.literal(0), z.literal(1), z.literal(5), z.literal(15)]),
  colorScheme: z.enum(['default', 'cool', 'warm', 'mono', 'status']),
  slaId: optionalId,
  /** Compare against the previous period (number tile). */
  compare: z.boolean(),
  label: z.string().max(100),
} as const

type Key = keyof typeof KEY_SCHEMAS
const COMMON: Key[] = ['title', 'refresh', 'colorScheme', 'showTable']
const SOURCE: Key[] = ['jql', 'filterId']

/** Allowed config keys per built-in gadget type, and the ones that must be present. */
export const GADGET_TYPES: Record<string, { keys: Key[]; required?: Key[]; requiresOneOf?: Key[][] }> = {
  'pie-chart': { keys: [...COMMON, ...SOURCE, 'field', 'chart', 'limit', 'sort'] },
  'issue-statistics': { keys: [...COMMON, ...SOURCE, 'field', 'metric', 'limit', 'sort'] },
  'two-dimensional': { keys: [...COMMON, ...SOURCE, 'field', 'field2', 'limit', 'metric'] },
  'filter-results': { keys: [...COMMON, ...SOURCE, 'columns', 'limit'] },
  'assigned-to-me': { keys: [...COMMON, 'columns', 'limit', 'jql'] },
  'recently-created': { keys: [...COMMON, ...SOURCE, 'projectId', 'limit', 'columns'] },
  'activity-stream': { keys: [...COMMON, 'limit', 'projectId'] },
  'created-vs-resolved': { keys: [...COMMON, ...SOURCE, 'days', 'period'] },
  'created-heatmap': { keys: [...COMMON, ...SOURCE, 'dateField', 'days'] },
  'due-date-calendar': { keys: [...COMMON, ...SOURCE, 'limit'] },
  workload: { keys: [...COMMON, ...SOURCE, 'metric', 'limit'] },
  stat: { keys: [...COMMON, ...SOURCE, 'label', 'compare', 'days'] },
  'sprint-health': { keys: [...COMMON, 'boardId', 'sprintId', 'unit'] },
  'sprint-burndown': { keys: [...COMMON, 'boardId', 'sprintId', 'unit'] },
  velocity: { keys: [...COMMON, 'boardId', 'count', 'unit'] },
  'cumulative-flow': { keys: [...COMMON, 'boardId', 'days'] },
  'version-progress': { keys: [...COMMON, 'projectId', 'versionId', 'epicKey', 'mode', 'limit'] },
  'average-age': { keys: [...COMMON, 'period', 'count'] },
  'resolution-time': { keys: [...COMMON, 'period', 'count'] },
  'sla-compliance': { keys: [...COMMON, 'deskId', 'days'] },
  'sla-breaches': { keys: [...COMMON, 'deskId', 'limit'] },
  csat: { keys: [...COMMON, 'deskId', 'days'] },
  'queue-counts': { keys: [...COMMON, 'deskId'] },
  notes: { keys: ['title', 'text', 'colorScheme', 'refresh'] },
}

const PLUGIN_TYPE = /^[a-z0-9][a-z0-9:_.-]{0,49}$/
export const MAX_PLUGIN_CONFIG_BYTES = 16 * 1024

export interface GadgetInput {
  type: string
  title?: string
  config?: Record<string, unknown>
  position?: { column?: number; row?: number }
  rect?: { x?: number; y?: number; w?: number; h?: number }
}

export interface ValidatedGadget {
  type: string
  config: Record<string, unknown>
  rect: { x: number; y: number; w: number; h: number } | null
  column: number
  row: number
  /** JQL strings to be checked against the JQL engine by the caller. */
  jqls: string[]
}

const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.floor(Number(v)) : fallback)

/** Clamp a rectangle to the 12-column grid. Returns null when no usable rectangle was supplied. */
export function sanitizeRect(raw: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (![r.x, r.y, r.w, r.h].every((v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)))) return null
  const w = Math.min(Math.max(num(r.w, 6), 1), 12)
  const h = Math.min(Math.max(num(r.h, 8), 1), 60)
  const x = Math.min(Math.max(num(r.x, 0), 0), 12 - w)
  const y = Math.min(Math.max(num(r.y, 0), 0), 2000)
  return { x, y, w, h }
}

/** Old two-column positions to a grid rectangle (matches the SQL backfill in migration 0002). */
export function legacyRect(column: unknown, row: unknown): { x: number; y: number; w: number; h: number } {
  const col = Math.min(Math.max(num(column, 0), 0), 1)
  const r = Math.max(num(row, 0), 0)
  return { x: col * 6, y: r * 8, w: 6, h: 8 }
}

export function validateGadget(input: unknown): { ok: true; value: ValidatedGadget } | { ok: false; errors: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['gadget must be an object'] }
  const g = input as GadgetInput
  if (typeof g.type !== 'string' || !g.type || g.type.length > 50) return { ok: false, errors: ['type is required'] }
  if (g.config !== undefined && (g.config === null || typeof g.config !== 'object' || Array.isArray(g.config))) {
    return { ok: false, errors: ['config must be an object'] }
  }
  const raw: Record<string, unknown> = { ...(g.config ?? {}) }
  if (typeof g.title === 'string' && g.title) raw.title = g.title.slice(0, 200)

  const rect = sanitizeRect(g.rect ?? g) ?? null
  const legacy = legacyRect(g.position?.column ?? (g as any).column, g.position?.row ?? (g as any).row)
  const finalRect = rect ?? (g.position || (g as any).column !== undefined ? legacy : null)
  const column = finalRect ? (finalRect.x >= 6 ? 1 : 0) : 0
  const row = finalRect ? finalRect.y : 0

  const def = GADGET_TYPES[g.type]
  if (!def) {
    if (!PLUGIN_TYPE.test(g.type)) return { ok: false, errors: [`unknown gadget type "${g.type}"`] }
    if (JSON.stringify(raw).length > MAX_PLUGIN_CONFIG_BYTES) return { ok: false, errors: ['config is too large'] }
    return { ok: true, value: { type: g.type, config: raw, rect: finalRect, column, row, jqls: [] } }
  }

  const errors: string[] = []
  const out: Record<string, unknown> = {}
  const allowed = new Set<string>(def.keys)
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) {
      errors.push(`${key}: not a setting of ${g.type}`)
      continue
    }
    if (value === undefined || value === null || value === '') continue // blank means "use the default"
    const parsed = KEY_SCHEMAS[key as Key].safeParse(value)
    if (!parsed.success) errors.push(`${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`)
    else out[key] = parsed.data
  }
  for (const key of def.required ?? []) if (out[key] === undefined) errors.push(`${key}: is required`)
  if (errors.length) return { ok: false, errors }

  const jqls: string[] = []
  if (typeof out.jql === 'string' && out.jql.trim()) jqls.push(out.jql)
  return { ok: true, value: { type: g.type, config: out, rect: finalRect, column, row, jqls } }
}

export function isKnownGadgetType(type: string): boolean {
  return type in GADGET_TYPES
}
