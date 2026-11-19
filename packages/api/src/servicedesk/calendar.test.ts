import { describe, it, expect } from 'bun:test'
import {
  ALWAYS_OPEN, SAMPLE_9_TO_5, addWorkingMillis, calendarFromBusinessHours, isValidTimeZone, validateWorkingHours,
  workingMillis, zoneOffsetMs, type Calendar,
} from './calendar'
import { DEFAULT_BUSINESS_HOURS } from './sla'

const H = 3_600_000
const M = 60_000
const utc = (mo: number, d: number, h = 0, mi = 0) => Date.UTC(2026, mo - 1, d, h, mi)
// 2026-11-09 is a Monday

describe('workingMillis', () => {
  const cases: Array<[string, Calendar, number, number, number]> = [
    ['one working day', SAMPLE_9_TO_5, utc(11, 9, 0), utc(11, 9, 23), 8 * H],
    ['partial start', SAMPLE_9_TO_5, utc(11, 9, 16), utc(11, 9, 20), 1 * H],
    ['across Friday to Monday skips weekend', SAMPLE_9_TO_5, utc(11, 13, 16), utc(11, 16, 10), 1 * H + 1 * H],
    ['pure weekend', SAMPLE_9_TO_5, utc(11, 14, 0), utc(11, 15, 23), 0],
    ['full week', SAMPLE_9_TO_5, utc(11, 9, 0), utc(11, 16, 0), 40 * H],
    ['24/7', ALWAYS_OPEN, utc(11, 9, 0), utc(11, 10, 0), 24 * H],
    ['empty range', SAMPLE_9_TO_5, utc(11, 9, 10), utc(11, 9, 10), 0],
    ['reverse range', SAMPLE_9_TO_5, utc(11, 9, 12), utc(11, 9, 10), 0],
  ]
  for (const [name, cal, a, b, expected] of cases) {
    it(name, () => expect(workingMillis(cal, a, b)).toBe(expected))
  }

  it('multiple intervals per day (lunch break) and per-day off', () => {
    const cal: Calendar = { timeZone: 'UTC', days: { mon: [['08:00', '12:00'], ['13:00', '17:00']], tue: [] } }
    expect(workingMillis(cal, utc(11, 9, 0), utc(11, 10, 0))).toBe(8 * H)
    expect(workingMillis(cal, utc(11, 9, 11), utc(11, 9, 14))).toBe(1 * H + 1 * H)
    expect(workingMillis(cal, utc(11, 10, 0), utc(11, 11, 0))).toBe(0)
  })

  it('unsorted intervals are handled', () => {
    const cal: Calendar = { days: { mon: [['13:00', '17:00'], ['08:00', '12:00']] } }
    expect(workingMillis(cal, utc(11, 9, 0), utc(11, 10, 0))).toBe(8 * H)
  })

  it('supports 24:00 as end of day', () => {
    const cal: Calendar = { days: { mon: [['00:00', '24:00']], tue: [['00:00', '24:00']] } }
    expect(workingMillis(cal, utc(11, 9, 12), utc(11, 10, 12))).toBe(24 * H)
  })

  describe('holidays', () => {
    const cal: Calendar = { ...SAMPLE_9_TO_5, holidays: [{ date: '2026-11-10', name: 'Day off' }, { date: '2020-12-25', recurring: true, name: 'Xmas' }] }
    it('one-off holiday removes a day', () => {
      expect(workingMillis(cal, utc(11, 9, 0), utc(11, 12, 0))).toBe(8 * H + 8 * H) // Mon + Wed
    })
    it('recurring holiday applies every year', () => {
      // 2026-12-25 is a Friday
      expect(workingMillis(cal, utc(12, 25, 0), utc(12, 26, 0))).toBe(0)
      expect(workingMillis(cal, utc(12, 24, 0), utc(12, 25, 0))).toBe(8 * H)
    })
    it('one-off holiday does not repeat next year', () => {
      // 2027-11-10 is a Wednesday
      expect(workingMillis(cal, Date.UTC(2027, 10, 10), Date.UTC(2027, 10, 11))).toBe(8 * H)
    })
  })

  describe('time zones', () => {
    it('fixed UTC offset (legacy business hours)', () => {
      const cal = calendarFromBusinessHours({ ...DEFAULT_BUSINESS_HOURS, utcOffsetMinutes: 180 })
      expect(workingMillis(cal, utc(11, 9, 6), utc(11, 9, 7))).toBe(H)
      expect(workingMillis(cal, utc(11, 9, 5), utc(11, 9, 6))).toBe(0)
    })
    it('IANA zone east of UTC: Mon 09-17 Europe/Berlin (UTC+1 in November) = 08-16 UTC', () => {
      const cal: Calendar = { ...SAMPLE_9_TO_5, timeZone: 'Europe/Berlin' }
      expect(workingMillis(cal, utc(11, 9, 0), utc(11, 9, 8))).toBe(0)
      expect(workingMillis(cal, utc(11, 9, 8), utc(11, 9, 16))).toBe(8 * H)
    })
    it('IANA zone west of UTC rolls into the next UTC day', () => {
      const cal: Calendar = { days: { mon: [['16:00', '20:00']] }, timeZone: 'America/New_York' }
      // Mon 16:00-20:00 EST = Mon 21:00 - Tue 01:00 UTC
      expect(workingMillis(cal, utc(11, 9, 21), utc(11, 10, 1))).toBe(4 * H)
      expect(workingMillis(cal, utc(11, 10, 1), utc(11, 10, 12))).toBe(0)
    })
    it('DST: a 09-17 day keeps 8 working hours on the spring-forward and fall-back weekdays', () => {
      const cal: Calendar = { ...SAMPLE_9_TO_5, timeZone: 'America/New_York' }
      // US DST starts Sun 2026-03-08, ends Sun 2026-11-01. Monday after each: local 9-17.
      const mar9 = Date.UTC(2026, 2, 9)
      expect(workingMillis(cal, mar9, mar9 + 24 * H)).toBe(8 * H)
      const nov2 = Date.UTC(2026, 10, 2)
      expect(workingMillis(cal, nov2, nov2 + 24 * H)).toBe(8 * H)
      // the same wall-clock window sits at 13:00 UTC in EDT and 14:00 UTC in EST
      expect(workingMillis(cal, Date.UTC(2026, 2, 9, 13), Date.UTC(2026, 2, 9, 21))).toBe(8 * H)
      expect(workingMillis(cal, Date.UTC(2026, 10, 2, 14), Date.UTC(2026, 10, 2, 22))).toBe(8 * H)
    })
    it('DST: overnight shift crossing the transition has the real elapsed length', () => {
      const cal: Calendar = { days: { sat: [['00:00', '24:00']] }, timeZone: 'America/New_York' }
      // Saturday 2026-03-07 is a normal day: 24h. Sunday's 23h is not working here.
      expect(workingMillis(cal, Date.UTC(2026, 2, 7), Date.UTC(2026, 2, 9))).toBe(24 * H)
      const sun: Calendar = { days: { sun: [['00:00', '24:00']] }, timeZone: 'America/New_York' }
      expect(workingMillis(sun, Date.UTC(2026, 2, 8), Date.UTC(2026, 2, 10))).toBe(23 * H)
    })
  })
})

describe('addWorkingMillis', () => {
  const cases: Array<[string, Calendar, number, number, number | null]> = [
    ['inside a day', SAMPLE_9_TO_5, utc(11, 9, 10), 2 * H, utc(11, 9, 12)],
    ['before opening starts at opening', SAMPLE_9_TO_5, utc(11, 9, 6), 1 * H, utc(11, 9, 10)],
    ['spills to next day', SAMPLE_9_TO_5, utc(11, 9, 16), 2 * H, utc(11, 10, 10)],
    ['Friday evening lands on Monday', SAMPLE_9_TO_5, utc(11, 13, 16), 2 * H, utc(11, 16, 10)],
    ['zero duration', SAMPLE_9_TO_5, utc(11, 9, 20), 0, utc(11, 9, 20)],
    ['24/7', ALWAYS_OPEN, utc(11, 9, 20), 30 * M, utc(11, 9, 20, 30)],
    ['empty calendar never', { days: {} }, utc(11, 9, 0), H, null],
  ]
  for (const [name, cal, from, dur, expected] of cases) {
    it(name, () => expect(addWorkingMillis(cal, from, dur)).toBe(expected))
  }
  it('skips holidays', () => {
    const cal: Calendar = { ...SAMPLE_9_TO_5, holidays: [{ date: '2026-11-10' }] }
    expect(addWorkingMillis(cal, utc(11, 9, 16), 2 * H)).toBe(utc(11, 11, 10))
  })
  it('is the inverse of workingMillis', () => {
    const cal: Calendar = { days: { mon: [['08:00', '12:00'], ['13:00', '17:00']], tue: [['08:00', '12:00']] }, timeZone: 'Europe/Berlin' }
    const from = utc(11, 9, 9)
    const due = addWorkingMillis(cal, from, 9 * H)!
    expect(workingMillis(cal, from, due)).toBe(9 * H)
  })
})

describe('zones and validation', () => {
  it('computes offsets', () => {
    expect(zoneOffsetMs(utc(11, 9, 12), 'Europe/Berlin')).toBe(H)
    expect(zoneOffsetMs(utc(7, 9, 12), 'Europe/Berlin')).toBe(2 * H)
    expect(zoneOffsetMs(utc(11, 9, 12), 'Asia/Kolkata')).toBe(5.5 * H)
  })
  it('validates time zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
  })
  it('validates working hours', () => {
    expect(validateWorkingHours({ mon: [['09:00', '17:00']] })).toEqual([])
    expect(validateWorkingHours({ mon: [['09:00', '24:00']] })).toEqual([])
    expect(validateWorkingHours({ mon: [['17:00', '09:00']] }).length).toBe(1)
    expect(validateWorkingHours({ mon: [['09:00', '12:00'], ['11:00', '13:00']] })).toEqual(['mon: intervals overlap'])
    expect(validateWorkingHours({ mon: [['9:00', '12:00']] }).length).toBe(1)
  })
})
