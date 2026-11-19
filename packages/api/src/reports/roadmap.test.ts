import { describe, it, expect } from 'bun:test'
import { buildRoadmap, resolveStart, validateDates, parseWindowDate, type RoadmapIssue, type RoadmapVersion } from './roadmap'

const d = (s: string) => Date.parse(`${s}T00:00:00.000Z`)
let n = 0
const mk = (over: Partial<RoadmapIssue>): RoadmapIssue => ({
  id: ++n, key: `P-${n}`, summary: `s${n}`, issueType: 'Task', category: 'todo', createdAt: d('2026-01-01'),
  startDate: null, dueDate: null, parentId: null, isEpic: false, isSubtask: false, storyPoints: null,
  firstInProgressAt: null, fixVersionIds: [], ...over,
})
const v = (over: Partial<RoadmapVersion> & { id: number }): RoadmapVersion => ({ name: `v${over.id}`, startDate: null, releaseDate: null, released: false, ...over })

describe('resolveStart', () => {
  it('prefers explicit, then first in-progress transition, then created', () => {
    expect(resolveStart(mk({ startDate: d('2026-03-01'), firstInProgressAt: d('2026-02-01') }))).toEqual({ at: d('2026-03-01'), source: 'explicit' })
    expect(resolveStart(mk({ firstInProgressAt: d('2026-02-01') }))).toEqual({ at: d('2026-02-01'), source: 'transition' })
    expect(resolveStart(mk({}))).toEqual({ at: d('2026-01-01'), source: 'created' })
  })
})

describe('buildRoadmap', () => {
  it('computes start/end sources and progress for epics', () => {
    const epic = mk({ key: 'E-1', isEpic: true, issueType: 'Epic', startDate: d('2026-02-01') })
    const a = mk({ parentId: epic.id, category: 'done', storyPoints: 3, dueDate: d('2026-02-10') })
    const b = mk({ parentId: epic.id, category: 'todo', storyPoints: 5, dueDate: d('2026-03-05') })
    const c = mk({ parentId: epic.id, category: 'in_progress', storyPoints: null })
    const r = buildRoadmap({ issues: [epic, a, b, c], versions: [], links: [] })
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({
      key: 'E-1', startSource: 'explicit', endSource: 'children',
      progress: { children: { done: 1, total: 3 }, points: { done: 3, total: 8 }, percent: 38 },
    })
    expect(r.items[0].end).toBe(new Date(d('2026-03-05')).toISOString())
  })

  it('own due date wins over children and versions; version release is the last fallback', () => {
    const e1 = mk({ isEpic: true, dueDate: d('2026-05-01'), fixVersionIds: [1] })
    const e2 = mk({ isEpic: true, fixVersionIds: [1, 2] })
    const e3 = mk({ isEpic: true })
    const r = buildRoadmap({
      issues: [e1, e2, e3],
      versions: [v({ id: 1, releaseDate: '2026-06-01' }), v({ id: 2, releaseDate: '2026-07-15' })],
      links: [],
    })
    const by = (id: number) => r.items.find((i) => i.key === `P-${id}`)!
    expect(by(e1.id)).toMatchObject({ endSource: 'due' })
    expect(by(e2.id)).toMatchObject({ endSource: 'version', end: new Date(d('2026-07-15')).toISOString() })
    expect(by(e3.id)).toMatchObject({ endSource: 'none', end: null })
  })

  it('uses story-point-less children count for percent, and clamps end before start', () => {
    const epic = mk({ isEpic: true, startDate: d('2026-04-10'), dueDate: d('2026-04-01') })
    const k1 = mk({ parentId: epic.id, category: 'done' })
    const k2 = mk({ parentId: epic.id })
    const r = buildRoadmap({ issues: [epic, k1, k2], versions: [], links: [] })
    expect(r.items[0].progress.percent).toBe(50)
    expect(r.items[0].end).toBe(r.items[0].start)
  })

  it('only includes orphans (non-epic, non-subtask, not under an epic) on request', () => {
    const epic = mk({ isEpic: true })
    const child = mk({ parentId: epic.id })
    const orphan = mk({ dueDate: d('2026-02-01') })
    const sub = mk({ isSubtask: true, parentId: orphan.id })
    const issues = [epic, child, orphan, sub]
    expect(buildRoadmap({ issues, versions: [], links: [] }).items.map((i) => i.key)).toEqual([epic.key])
    const withOrphans = buildRoadmap({ issues, versions: [], links: [], includeOrphans: true }).items.map((i) => i.key)
    expect(withOrphans.sort()).toEqual([epic.key, orphan.key].sort())
  })

  it('filters by window and lists dated versions as milestones', () => {
    const early = mk({ isEpic: true, startDate: d('2025-01-01'), dueDate: d('2025-02-01') })
    const inside = mk({ isEpic: true, startDate: d('2026-02-01'), dueDate: d('2026-03-01') })
    const late = mk({ isEpic: true, startDate: d('2027-01-01'), dueDate: d('2027-02-01') })
    const r = buildRoadmap({
      issues: [early, inside, late],
      versions: [v({ id: 1, releaseDate: '2026-02-15' }), v({ id: 2, releaseDate: '2028-01-01' }), v({ id: 3 })],
      links: [], from: d('2026-01-01'), to: d('2026-12-31'),
    })
    expect(r.items.map((i) => i.key)).toEqual([inside.key])
    expect(r.versions.map((x) => x.id)).toEqual([1])
  })

  it('returns Blocks dependencies between items, lifting child links to their epic and de-duplicating', () => {
    const e1 = mk({ isEpic: true, startDate: d('2026-01-01') })
    const e2 = mk({ isEpic: true, startDate: d('2026-02-01') })
    const c1 = mk({ parentId: e1.id })
    const c2 = mk({ parentId: e2.id })
    const stray = mk({})
    const r = buildRoadmap({
      issues: [e1, e2, c1, c2, stray], versions: [],
      links: [
        { fromId: e1.id, toId: e2.id },
        { fromId: c1.id, toId: c2.id }, // lifts to e1 -> e2 (duplicate)
        { fromId: c1.id, toId: c1.id }, // self after lift is ignored
        { fromId: stray.id, toId: e2.id }, // stray is not an item
      ],
    })
    expect(r.dependencies).toEqual([{ from: e1.key, to: e2.key, kind: 'blocks', conflict: false, message: null }])
  })
})

describe('validateDates / parseWindowDate', () => {
  it('accepts valid ranges and nulls', () => {
    expect(validateDates('2026-01-01', '2026-01-01')).toBeNull()
    expect(validateDates(null, '2026-05-01')).toBeNull()
    expect(validateDates(undefined, null)).toBeNull()
  })
  it('rejects bad formats, impossible dates and start after due', () => {
    expect(validateDates('2026-02-30', null)).toMatch(/valid date/)
    expect(validateDates('01/02/2026', null)).toMatch(/yyyy-mm-dd/)
    expect(validateDates('2026-03-02', '2026-03-01')).toMatch(/not be after/)
    expect(validateDates('1800-01-01', null)).toMatch(/between/)
  })
  it('parses window dates', () => {
    expect(parseWindowDate('2026-01-05')).toBe(d('2026-01-05'))
    expect(parseWindowDate('nope')).toBeNull()
    expect(parseWindowDate(undefined)).toBeNull()
  })
})

describe('buildRoadmap dependencies and cancelled work', () => {
  it('flags finishes-before dependencies whose predecessor ends after the successor starts', () => {
    const a = mk({ isEpic: true, startDate: d('2026-01-01'), dueDate: d('2026-03-01') })
    const b = mk({ isEpic: true, startDate: d('2026-02-15'), dueDate: d('2026-04-01') })
    const c = mk({ isEpic: true, startDate: d('2026-03-10'), dueDate: d('2026-04-01') })
    const r = buildRoadmap({
      issues: [a, b, c], versions: [],
      links: [
        { fromId: a.id, toId: b.id, kind: 'finishes_before' }, // a ends 03-01, b starts 02-15: conflict
        { fromId: a.id, toId: c.id, kind: 'finishes_before' }, // fine
        { fromId: a.id, toId: c.id, kind: 'starts_before' },
      ],
    })
    const dep = (to: string, kind: string) => r.dependencies.find((x) => x.to === to && x.kind === kind)!
    expect(dep(b.key, 'finishes_before')).toMatchObject({ conflict: true })
    expect(dep(b.key, 'finishes_before').message).toMatch(/ends after/)
    expect(dep(c.key, 'finishes_before').conflict).toBe(false)
    expect(dep(c.key, 'starts_before').conflict).toBe(false)
  })

  it('leaves cancelled children out of progress', () => {
    const e = mk({ isEpic: true, startDate: d('2026-01-01') })
    const kids = [mk({ parentId: e.id, category: 'done' }), mk({ parentId: e.id, category: 'cancelled' }), mk({ parentId: e.id, category: 'cancelled' }), mk({ parentId: e.id, category: 'todo' })]
    const r = buildRoadmap({ issues: [e, ...kids], versions: [], links: [] })
    expect(r.items[0].progress).toMatchObject({ children: { done: 1, total: 2 }, percent: 50 })
  })
})
