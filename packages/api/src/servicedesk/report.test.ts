import { describe, expect, test } from 'bun:test'
import { csatDistribution, dailySeries, workloadByAgent, type ReportRow } from './report'

const d = (s: string) => new Date(s)
const row = (p: Partial<ReportRow>): ReportRow => ({ createdAt: d('2026-11-10T10:00:00Z'), resolvedAt: null, assigneeId: null, assigneeName: null, csatRating: null, ...p })

describe('service desk report aggregation', () => {
  test('dailySeries buckets created and resolved, ignores out-of-range', () => {
    const now = d('2026-11-10T12:00:00Z')
    const s = dailySeries([
      row({ createdAt: d('2026-11-09T01:00:00Z'), resolvedAt: d('2026-11-10T01:00:00Z') }),
      row({ createdAt: d('2026-11-10T09:00:00Z') }),
      row({ createdAt: d('2026-01-01T00:00:00Z'), resolvedAt: d('2026-01-02T00:00:00Z') }),
    ], 3, now)
    expect(s.map((x) => x.date)).toEqual(['2026-11-08', '2026-11-09', '2026-11-10'])
    expect(s[1]).toMatchObject({ created: 1, resolved: 0 })
    expect(s[2]).toMatchObject({ created: 1, resolved: 1 })
  })

  test('workloadByAgent counts open and recently resolved, groups unassigned', () => {
    const since = d('2026-11-01T00:00:00Z')
    const w = workloadByAgent([
      row({ assigneeId: 1, assigneeName: 'Ann' }),
      row({ assigneeId: 1, assigneeName: 'Ann', resolvedAt: d('2026-11-05T00:00:00Z') }),
      row({ assigneeId: 1, assigneeName: 'Ann', resolvedAt: d('2026-10-01T00:00:00Z') }),
      row({}),
    ], since)
    expect(w[0]).toEqual({ userId: 1, name: 'Ann', open: 1, resolved: 1 })
    expect(w[1]).toEqual({ userId: null, name: 'Unassigned', open: 1, resolved: 0 })
  })

  test('csatDistribution', () => {
    const dist = csatDistribution([row({ csatRating: 5 }), row({ csatRating: 5 }), row({ csatRating: 1 }), row({})])
    expect(dist.map((x) => x.count)).toEqual([1, 0, 0, 0, 2])
  })
})

import { csatSummary, csatTrend, csatByGroup, needsFollowUp, weekStart, type CsatRow } from './report'

describe('CSAT reporting', () => {
  const row = (rating: number | null, day: string, key: string | null, name: string | null, resolved = true): CsatRow => ({ rating, ratedAt: rating ? new Date(day) : null, resolved, groupKey: key, groupName: name })
  const rows = [row(5, '2026-11-02', 'a', 'Ann'), row(4, '2026-11-03', 'a', 'Ann'), row(1, '2026-11-10', 'b', 'Bob'), row(null, '2026-11-11', 'b', 'Bob'), row(2, '2026-11-11', null, null)]
  test('summarises average, satisfied share and response rate', () => {
    const s = csatSummary(rows)
    expect(s.responses).toBe(4)
    expect(s.average).toBe(3)
    expect(s.satisfiedPct).toBe(50)
    expect(s.responseRatePct).toBe(80)
    expect(csatSummary([]).average).toBeNull()
  })
  test('weeks start on Monday and the trend includes empty weeks', () => {
    expect(weekStart(new Date('2026-11-12'))).toBe('2026-11-09')
    const t = csatTrend(rows, new Date('2026-10-26'), new Date('2026-11-12'))
    expect(t.map((w) => w.week)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09'])
    expect(t.map((w) => w.responses)).toEqual([0, 2, 2])
    expect(t[1].average).toBe(4.5)
    expect(t[0].average).toBeNull()
  })
  test('groups by agent with an Unassigned bucket, best first', () => {
    const g = csatByGroup(rows)
    expect(g.map((x) => x.name)).toEqual(['Ann', 'Unassigned', 'Bob'])
    expect(g[0].average).toBe(4.5)
  })
  test('only poor ratings that nobody handled need follow-up', () => {
    expect(needsFollowUp(1, null)).toBe(true)
    expect(needsFollowUp(2, new Date())).toBe(false)
    expect(needsFollowUp(3, null)).toBe(false)
    expect(needsFollowUp(null, null)).toBe(false)
  })
})

import { kbArticleStats, searchStats, normalizeTerm, automationRunStats } from './report'

describe('knowledge base and automation insights', () => {
  test('article stats: helpful share and ordering by views', () => {
    const d = new Date('2026-11-01')
    const s = kbArticleStats([
      { id: 1, title: 'B', published: true, views: 5, helpful: 3, notHelpful: 1, updatedAt: d },
      { id: 2, title: 'A', published: true, views: 9, helpful: 0, notHelpful: 0, updatedAt: d },
    ])
    expect(s.map((a) => a.id)).toEqual([2, 1])
    expect(s[0].helpfulPct).toBeNull()
    expect(s[1].helpfulPct).toBe(75)
    expect(s[1].votes).toBe(4)
  })
  test('search terms are grouped and the ones without results are gaps', () => {
    expect(normalizeTerm('  VPN   Setup ')).toBe('vpn setup')
    const r = searchStats([{ term: 'VPN', results: 2 }, { term: 'vpn ', results: 0 }, { term: 'printer', results: 0 }, { term: 'printer', results: 0 }, { term: ' ', results: 0 }])
    expect(r.top.map((t) => [t.term, t.searches])).toEqual([['printer', 2], ['vpn', 2]])
    expect(r.gaps.map((g) => g.term)).toEqual(['printer'])
  })
  test('automation run stats count failures and keep the newest failure text', () => {
    const t = (d: string) => new Date(d)
    const s = automationRunStats([
      { ruleId: 1, outcome: 'commented', ranAt: t('2026-11-01') },
      { ruleId: 1, outcome: 'failed: no transition', ranAt: t('2026-11-03') },
      { ruleId: 1, outcome: 'failed: other', ranAt: t('2026-11-02') },
      { ruleId: 2, outcome: 'notified 1', ranAt: t('2026-11-04') },
    ])
    expect(s.find((x) => x.ruleId === 1)).toMatchObject({ runs: 3, failures: 2, lastFailure: 'failed: no transition' })
    expect(s.find((x) => x.ruleId === 2)).toMatchObject({ runs: 1, failures: 0, lastFailure: null })
  })
})
