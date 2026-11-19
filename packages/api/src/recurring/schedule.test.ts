import { describe, expect, test } from 'bun:test';
import { nextOccurrence, validateRule, zonedTimeToUtc, type ScheduleRule } from './schedule';
import { renderSummaryPattern, isoWeek } from '../templates/pattern';

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('nextOccurrence', () => {
  test('daily in UTC', () => {
    const r: ScheduleRule = { frequency: 'daily', timeOfDay: '09:00', timezone: 'UTC' };
    expect(iso(nextOccurrence(r, new Date('2026-03-09T08:00:00Z')))).toBe('2026-03-09T09:00:00.000Z');
    expect(iso(nextOccurrence(r, new Date('2026-03-09T09:00:00Z')))).toBe('2026-03-10T09:00:00.000Z'); // strictly after
  });
  test('weekdays skip the weekend (empty list means Monday to Friday)', () => {
    const r: ScheduleRule = { frequency: 'weekly', daysOfWeek: [], timeOfDay: '07:30', timezone: 'UTC' };
    expect(iso(nextOccurrence(r, new Date('2026-03-13T12:00:00Z')))).toBe('2026-03-16T07:30:00.000Z'); // Friday -> Monday
  });
  test('weekly on chosen days', () => {
    const r: ScheduleRule = { frequency: 'weekly', daysOfWeek: [3], timeOfDay: '10:00', timezone: 'UTC' };
    expect(iso(nextOccurrence(r, new Date('2026-03-09T00:00:00Z')))).toBe('2026-03-11T10:00:00.000Z');
  });
  test('monthly clamps to the last day of short months', () => {
    const r: ScheduleRule = { frequency: 'monthly', dayOfMonth: 31, timeOfDay: '06:00', timezone: 'UTC' };
    expect(iso(nextOccurrence(r, new Date('2026-02-01T00:00:00Z')))).toBe('2026-02-28T06:00:00.000Z');
    expect(iso(nextOccurrence(r, new Date('2026-02-28T06:00:00Z')))).toBe('2026-03-31T06:00:00.000Z');
  });
  test('timezone and DST: 09:00 Berlin is 08:00 UTC in winter and 07:00 UTC in summer', () => {
    const r: ScheduleRule = { frequency: 'daily', timeOfDay: '09:00', timezone: 'Europe/Berlin' };
    expect(iso(nextOccurrence(r, new Date('2026-01-10T00:00:00Z')))).toBe('2026-01-10T08:00:00.000Z');
    expect(iso(nextOccurrence(r, new Date('2026-07-10T00:00:00Z')))).toBe('2026-07-10T07:00:00.000Z');
    // across the spring change (2026-03-29) the wall clock time stays 09:00
    expect(iso(nextOccurrence(r, new Date('2026-03-28T08:00:00Z')))).toBe('2026-03-29T07:00:00.000Z');
  });
  test('local date differs from UTC date', () => {
    const r: ScheduleRule = { frequency: 'daily', timeOfDay: '01:00', timezone: 'Pacific/Auckland' };
    // 2026-06-30T12:30Z is 2026-07-01 00:30 in Auckland (UTC+12), so the next 01:00 is 30 minutes later
    expect(iso(nextOccurrence(r, new Date('2026-06-30T12:30:00Z')))).toBe('2026-06-30T13:00:00.000Z');
  });
  test('validation', () => {
    expect(validateRule({ frequency: 'daily', timeOfDay: '25:00', timezone: 'UTC' })).toMatch(/timeOfDay/);
    expect(validateRule({ frequency: 'daily', timeOfDay: '09:00', timezone: 'Nowhere/City' })).toMatch(/timezone/);
    expect(validateRule({ frequency: 'monthly', timeOfDay: '09:00', timezone: 'UTC' })).toMatch(/dayOfMonth/);
    expect(validateRule({ frequency: 'weekly', daysOfWeek: [8], timeOfDay: '09:00', timezone: 'UTC' })).toMatch(/daysOfWeek/);
    expect(zonedTimeToUtc(2026, 1, 1, 0, 0, 'UTC').toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('summary pattern', () => {
  test('placeholders use the rule time zone', () => {
    const at = new Date('2026-03-09T23:30:00Z'); // Tuesday 10 March 00:30 in Berlin (UTC+1)
    expect(renderSummaryPattern('Report {date} W{week} {weekday} {monthName} {project} {x}', { at, timezone: 'Europe/Berlin', projectKey: 'OPS' }))
      .toBe('Report 2026-03-10 W11 Tuesday March OPS {x}');
  });
  test('iso week edge cases', () => {
    expect(isoWeek(2026, 1, 1)).toBe(1);
    expect(isoWeek(2021, 1, 3)).toBe(53);
  });
});
