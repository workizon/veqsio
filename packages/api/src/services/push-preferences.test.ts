import { describe, test, expect } from 'bun:test'
import { DEFAULT_PREFS, inQuietHours, isHHMM, minutesOfDayIn, resolvedEvents, shouldPush, validTimeZone, type PushPrefs } from './push-preferences'

const prefs = (over: Partial<PushPrefs> = {}): PushPrefs => ({ ...DEFAULT_PREFS, ...over })
const at = (iso: string) => new Date(iso)

describe('push preferences', () => {
  test('time and zone validation', () => {
    expect(isHHMM('07:05')).toBe(true)
    expect(isHHMM('24:00')).toBe(false)
    expect(isHHMM('7:05')).toBe(false)
    expect(isHHMM('07:60')).toBe(false)
    expect(validTimeZone('Europe/Berlin')).toBe(true)
    expect(validTimeZone('UTC')).toBe(true)
    expect(validTimeZone('Mars/Olympus')).toBe(false)
    expect(validTimeZone('')).toBe(false)
    expect(validTimeZone(5)).toBe(false)
  })

  test('minutes of the day follow the time zone, including daylight saving', () => {
    expect(minutesOfDayIn('UTC', at('2026-11-16T09:30:00Z'))).toBe(9 * 60 + 30)
    expect(minutesOfDayIn('Europe/Berlin', at('2026-11-16T09:30:00Z'))).toBe(10 * 60 + 30)   // winter: UTC+1
    expect(minutesOfDayIn('Europe/Berlin', at('2026-07-16T09:30:00Z'))).toBe(11 * 60 + 30)   // summer: UTC+2
    expect(minutesOfDayIn('Asia/Kolkata', at('2026-11-16T09:30:00Z'))).toBe(15 * 60)         // UTC+5:30
    expect(minutesOfDayIn('UTC', at('2026-11-16T00:00:00Z'))).toBe(0)                        // midnight is 0, not 24:00
  })

  test('quiet hours within one day and across midnight', () => {
    const day = prefs({ quietEnabled: true, quietStart: '12:00', quietEnd: '14:00' })
    expect(inQuietHours(day, at('2026-11-16T11:59:00Z'))).toBe(false)
    expect(inQuietHours(day, at('2026-11-16T12:00:00Z'))).toBe(true)
    expect(inQuietHours(day, at('2026-11-16T13:59:00Z'))).toBe(true)
    expect(inQuietHours(day, at('2026-11-16T14:00:00Z'))).toBe(false)   // the end is not quiet any more
    const night = prefs({ quietEnabled: true, quietStart: '22:00', quietEnd: '07:00' })
    expect(inQuietHours(night, at('2026-11-16T21:59:00Z'))).toBe(false)
    expect(inQuietHours(night, at('2026-11-16T22:00:00Z'))).toBe(true)
    expect(inQuietHours(night, at('2026-11-17T02:00:00Z'))).toBe(true)
    expect(inQuietHours(night, at('2026-11-17T06:59:00Z'))).toBe(true)
    expect(inQuietHours(night, at('2026-11-17T07:00:00Z'))).toBe(false)
  })

  test('quiet hours use the person’s own zone', () => {
    const berlin = prefs({ quietEnabled: true, quietStart: '22:00', quietEnd: '07:00', timezone: 'Europe/Berlin' })
    expect(inQuietHours(berlin, at('2026-11-16T21:30:00Z'))).toBe(true)    // 22:30 in Berlin
    expect(inQuietHours(berlin, at('2026-11-16T20:30:00Z'))).toBe(false)   // 21:30 in Berlin
    expect(inQuietHours(berlin, at('2026-11-17T05:59:00Z'))).toBe(true)    // 06:59 in Berlin
    expect(inQuietHours(berlin, at('2026-11-17T06:00:00Z'))).toBe(false)   // 07:00 in Berlin
  })

  test('disabled, equal or broken settings never silence anything', () => {
    const t = at('2026-11-17T02:00:00Z')
    expect(inQuietHours(prefs({ quietEnabled: false }), t)).toBe(false)
    expect(inQuietHours(prefs({ quietEnabled: true, quietStart: '08:00', quietEnd: '08:00' }), t)).toBe(false)
    expect(inQuietHours(prefs({ quietEnabled: true, quietStart: 'nope' as any, quietEnd: '07:00' }), t)).toBe(false)
    // an unknown zone falls back to UTC instead of throwing
    expect(inQuietHours(prefs({ quietEnabled: true, quietStart: '22:00', quietEnd: '07:00', timezone: 'Mars/Olympus' }), t)).toBe(true)
  })

  test('shouldPush: no row means everything, switches are per kind, on-call ignores quiet hours but not its own switch', () => {
    const t = at('2026-11-17T02:00:00Z')
    expect(shouldPush(undefined, 'comment', t)).toBe(true)
    const p = prefs({ events: { comment: false }, quietEnabled: true, quietStart: '22:00', quietEnd: '07:00' })
    expect(shouldPush(p, 'comment', at('2026-11-16T12:00:00Z'))).toBe(false)   // switched off at any hour
    expect(shouldPush(p, 'mention', at('2026-11-16T12:00:00Z'))).toBe(true)    // day time, switch on
    expect(shouldPush(p, 'mention', t)).toBe(false)                            // quiet hours
    expect(shouldPush(p, 'assignment', t)).toBe(false)
    expect(shouldPush(p, 'oncall', t)).toBe(true)                              // urgent
    expect(shouldPush(prefs({ events: { oncall: false } }), 'oncall', t)).toBe(false)
  })

  test('resolvedEvents lists every kind, missing switches are on', () => {
    expect(resolvedEvents({})).toEqual({ assignment: true, mention: true, comment: true, oncall: true })
    expect(resolvedEvents({ comment: false })).toEqual({ assignment: true, mention: true, comment: false, oncall: true })
  })
})
