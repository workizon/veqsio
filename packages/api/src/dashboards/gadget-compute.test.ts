import { describe, it, expect } from 'bun:test'
import { computeGadget, isRowGadget, needsMulti } from './gadget-compute'
import type { GadgetRow } from './gadget-data'

const now = new Date('2026-03-31T12:00:00Z')
const row = (o: Partial<GadgetRow>): GadgetRow => ({
  id: 1, key: 'A-1', summary: 's', status: 'Open', statusCategory: 'todo', priority: 'High', type: 'Bug', assignee: 'Ann', reporter: 'Bob', resolution: null,
  project: 'A', projectKey: 'A', labels: [], components: [], fixVersions: [], createdAt: new Date('2026-03-30T10:00:00Z'), updatedAt: null, resolvedAt: null, dueDate: null, timeEstimate: null, timeSpent: null, ...o,
})
const rows = [row({ id: 1 }), row({ id: 2, key: 'A-2', assignee: 'Ann', priority: 'Low' }), row({ id: 3, key: 'A-3', assignee: null, createdAt: new Date('2026-03-20T10:00:00Z'), dueDate: new Date('2026-04-02T00:00:00Z') })]

describe('computeGadget', () => {
  it('knows its types', () => {
    expect(isRowGadget('workload')).toBe(true)
    expect(isRowGadget('velocity')).toBe(false)
    expect(needsMulti({ field: 'labels' })).toBe(true)
    expect(needsMulti({ field: 'status' })).toBe(false)
  })
  it('workload and statistics bucket rows', () => {
    const w: any = computeGadget('workload', {}, rows, 3, now)
    expect(w.buckets[0]).toEqual({ name: 'Ann', value: 2 })
    const s: any = computeGadget('issue-statistics', { field: 'priority' }, rows, 3, now)
    expect(s.buckets.map((b: any) => b.name).sort()).toEqual(['High', 'Low'])
  })
  it('two-dimensional makes a table', () => {
    const t: any = computeGadget('two-dimensional', { field: 'assignee', field2: 'priority' }, rows, 3, now)
    expect(t.rows[0].name).toBe('Ann')
    expect(t.columns).toContain('High')
  })
  it('stat reports the total and, when asked, the change against the previous window', () => {
    expect(computeGadget('stat', {}, rows, 3, now)).toMatchObject({ total: 3, truncated: false })
    const c: any = computeGadget('stat', { compare: true, days: 7 }, rows, 3, now)
    expect(c.current).toBe(2)
    expect(c.previous).toBe(1)
    expect(c.delta).toBe(1)
  })
  it('heat map is zero filled over the window', () => {
    const h: any = computeGadget('created-heatmap', { days: 30 }, rows, 3, now)
    expect(h.days.length).toBe(30)
    expect(h.total).toBe(3)
    expect(h.max).toBe(2)
  })
  it('due calendar lists the issue with a due date', () => {
    const d: any = computeGadget('due-date-calendar', {}, rows, 3, now)
    expect(d.days.map((x: any) => x.date)).toEqual(['2026-04-02'])
  })
})
