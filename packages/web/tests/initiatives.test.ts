import { setActiveLocale } from '@/lib/i18n'
import { describe, test, expect } from 'bun:test'
import { dateRangeText, initiativeStatusBadge, milestoneDays, milestoneMarker, progressText, timelineStrip } from '../lib/initiatives'
import { dayOf } from '../lib/roadmap-layout'

const today = new Date('2026-06-15T12:00:00Z')

describe('initiative helpers', () => {
  test('status badge labels and unknown fallback', () => {
    expect(initiativeStatusBadge('active').label).toBe('Active')
    expect(new Set(['planned', 'active', 'completed', 'cancelled'].map((s) => initiativeStatusBadge(s).color)).size).toBe(4)
    expect(initiativeStatusBadge('x')).toEqual({ label: 'x', color: '#667085' })
  })

  test('progress text mentions cancelled work and empty state', () => {
    expect(progressText({ total: 7, done: 3, percentDone: 43 })).toBe('3 of 7 done (43%)')
    expect(progressText({ total: 7, done: 3, percentDone: 43, cancelled: 1 })).toBe('3 of 7 done (43%), 1 cancelled')
    expect(progressText({ total: 0, done: 0, percentDone: 0 })).toBe('No work yet')
    expect(progressText({ total: 0, done: 0, percentDone: 0, cancelled: 2 })).toBe('No open work (2 cancelled)')
  })

  test('timeline strip: position of today between start and target', () => {
    const s = timelineStrip('2026-06-01', '2026-06-30', 'active', today)
    expect(s.state).toBe('in-progress')
    expect(s.todayPct).toBe(48)
    expect(s.daysLeft).toBe(15)
    expect(s.label).toBe('15 days left')
  })

  test('timeline strip: not started, overdue, finished and missing dates', () => {
    expect(timelineStrip('2026-07-01', '2026-08-01', 'planned', today)).toMatchObject({ state: 'not-started', todayPct: 0, label: 'Starts in 16 days' })
    expect(timelineStrip('2026-05-01', '2026-06-10', 'active', today)).toMatchObject({ state: 'overdue', todayPct: 100, label: '5 days past the target' })
    expect(timelineStrip('2026-05-01', '2026-06-10', 'completed', today)).toMatchObject({ state: 'finished', label: 'Completed' })
    expect(timelineStrip(null, null, 'active', today)).toMatchObject({ state: 'no-dates', todayPct: null, label: 'No dates set' })
    expect(timelineStrip(null, '2026-06-16', 'active', today)).toMatchObject({ state: 'no-dates', label: '1 day left' })
    expect(timelineStrip('2026-06-15', '2026-06-15', 'active', today)).toMatchObject({ state: 'in-progress', label: 'Target is today' })
  })

  test('date range text', () => {
    expect(dateRangeText(null, null)).toBe('No dates')
    expect(dateRangeText('2026-01-01', '2026-12-31')).toBe('Jan 1, 2026 – Dec 31, 2026')
    setActiveLocale('de')
    expect(dateRangeText('2026-01-01', '2026-12-31')).toBe('1. Jan. 2026 – 31. Dez. 2026')
    setActiveLocale('en')
    expect(dateRangeText('2026-01-01', null)).toContain('no target')
  })
})

describe('milestone helpers', () => {
  const start = dayOf('2026-06-01')
  test('marker position scales with pixels per day', () => {
    const m = { id: 1, name: 'Beta', targetDate: '2026-06-11', state: 'open', percent: 40 }
    expect(milestoneMarker(m, start, 8, Date.parse('2026-06-05')).x).toBe(80)
    expect(milestoneMarker(m, start, 28, Date.parse('2026-06-05')).x).toBe(280)
  })
  test('state decides colour and text; the text is not colour-only', () => {
    const open = milestoneMarker({ id: 1, name: 'Beta', targetDate: '2026-06-11', state: 'open', percent: 40 }, start, 8, Date.parse('2026-06-05'))
    const late = milestoneMarker({ id: 1, name: 'Beta', targetDate: '2026-06-11', state: 'open', percent: 40 }, start, 8, Date.parse('2026-06-20'))
    const done = milestoneMarker({ id: 1, name: 'Beta', targetDate: '2026-06-11', state: 'reached', percent: 100 }, start, 8, Date.parse('2026-06-20'))
    expect(open.overdue).toBe(false)
    expect(late.overdue).toBe(true)
    expect(done.overdue).toBe(false)
    expect(new Set([open.color, late.color, done.color]).size).toBe(3)
    expect(open.label).toContain('open')
    expect(late.label).toContain('overdue')
    expect(done.label).toContain('reached')
  })
  test('milestoneDays skips undated milestones', () => {
    expect(milestoneDays([{ targetDate: '2026-06-01' }, { targetDate: null }])).toEqual([start])
  })
})
