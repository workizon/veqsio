/**
 * Turns permission-scoped issue rows into the payload of one JQL-based gadget. Pure, so it is unit tested without a database.
 * Gadgets that need other engines (sprints, SLA, CSAT) are not here.
 */
import { GADGET_TYPES } from './gadget-config'
import { countBy, crossTab, dailyCounts, dueByDay, trend, type GadgetRow, type Metric } from './gadget-data'

export const ROW_GADGETS = ['issue-statistics', 'two-dimensional', 'workload', 'stat', 'recently-created', 'created-heatmap', 'due-date-calendar'] as const
export type RowGadget = (typeof ROW_GADGETS)[number]
export const isRowGadget = (t: string): t is RowGadget => (ROW_GADGETS as readonly string[]).includes(t)

/** Fields that are multi-valued and need their join loaded. */
export const needsMulti = (config: Record<string, unknown>) =>
  ['labels', 'component', 'fixversion'].some((f) => config.field === f || config.field2 === f)

const metricOf = (c: Record<string, unknown>): Metric => (c.metric === 'estimate' || c.metric === 'spent' ? c.metric : 'count')
const intOr = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.floor(Number(v)) : d)

export function computeGadget(type: RowGadget, config: Record<string, unknown>, rows: GadgetRow[], total: number, now = new Date()): Record<string, unknown> {
  const limit = intOr(config.limit, 10)
  switch (type) {
    case 'issue-statistics':
      return countBy(rows, String(config.field ?? 'status'), { metric: metricOf(config), limit, sort: config.sort === 'name' ? 'name' : 'count' })
    case 'workload':
      return countBy(rows, 'assignee', { metric: metricOf(config), limit })
    case 'two-dimensional':
      return crossTab(rows, String(config.field ?? 'status'), String(config.field2 ?? 'priority'), { metric: metricOf(config), limit: intOr(config.limit, 12) }) as unknown as Record<string, unknown>
    case 'stat': {
      const days = intOr(config.days, 7)
      return { total, ...(config.compare ? trend(rows, days, now) : {}), truncated: rows.length < total }
    }
    case 'recently-created':
      return { issues: rows.slice(0, limit).map((r) => ({ key: r.key, summary: r.summary, status: r.status, statusCategory: r.statusCategory, type: r.type, assignee: r.assignee, createdAt: r.createdAt?.toISOString() ?? null })), total }
    case 'created-heatmap': {
      const days = Math.min(Math.max(intOr(config.days, 120), 7), 365)
      const field = (['created', 'resolved', 'updated', 'due'] as const).includes(config.dateField as never) ? (config.dateField as string) : 'created'
      const pick = (r: GadgetRow) => (field === 'resolved' ? r.resolvedAt : field === 'updated' ? r.updatedAt : field === 'due' ? r.dueDate : r.createdAt)
      const cells = dailyCounts(rows.map(pick), days, now)
      return { field, days: cells, max: Math.max(0, ...cells.map((c) => c.count)), total: cells.reduce((a, c) => a + c.count, 0) }
    }
    case 'due-date-calendar': {
      const from = new Date(now.getTime() - 7 * 86_400_000)
      const to = new Date(now.getTime() + 60 * 86_400_000)
      return { days: dueByDay(rows, from, to).slice(0, intOr(config.limit, 60)) }
    }
  }
}

/** Source-related config keys a row gadget accepts (kept in step with GADGET_TYPES). */
export const allowedKeys = (type: RowGadget) => new Set<string>(GADGET_TYPES[type].keys)
