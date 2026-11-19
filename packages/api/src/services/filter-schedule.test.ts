import { describe, it, expect } from 'bun:test';
import { currentPeriodStart, isSubscriptionDue } from './filter-schedule';

const d = (s: string) => new Date(s);
// 2030-01-08 is a Tuesday (weekday 2)
const daily = (hour: number, lastSentAt: Date | null, createdAt = d('2030-01-01T00:00:00Z')) =>
  ({ schedule: 'daily', hour, weekday: null, lastSentAt, createdAt });
const weekly = (hour: number, weekday: number, lastSentAt: Date | null, createdAt = d('2030-01-01T00:00:00Z')) =>
  ({ schedule: 'weekly', hour, weekday, lastSentAt, createdAt });

describe('currentPeriodStart', () => {
  it('daily: today when the hour has passed, yesterday otherwise', () => {
    expect(currentPeriodStart({ schedule: 'daily', hour: 8, weekday: null }, d('2030-01-08T10:00:00Z')).toISOString()).toBe('2030-01-08T08:00:00.000Z');
    expect(currentPeriodStart({ schedule: 'daily', hour: 8, weekday: null }, d('2030-01-08T07:59:59Z')).toISOString()).toBe('2030-01-07T08:00:00.000Z');
    expect(currentPeriodStart({ schedule: 'daily', hour: 8, weekday: null }, d('2030-01-08T08:00:00Z')).toISOString()).toBe('2030-01-08T08:00:00.000Z');
  });
  it('weekly: most recent matching weekday', () => {
    const now = d('2030-01-08T10:00:00Z'); // Tuesday
    expect(currentPeriodStart({ schedule: 'weekly', hour: 9, weekday: 2 }, now).toISOString()).toBe('2030-01-08T09:00:00.000Z');
    expect(currentPeriodStart({ schedule: 'weekly', hour: 11, weekday: 2 }, now).toISOString()).toBe('2030-01-01T11:00:00.000Z');
    expect(currentPeriodStart({ schedule: 'weekly', hour: 9, weekday: 1 }, now).toISOString()).toBe('2030-01-07T09:00:00.000Z');
    expect(currentPeriodStart({ schedule: 'weekly', hour: 9, weekday: 3 }, now).toISOString()).toBe('2030-01-02T09:00:00.000Z');
    expect(currentPeriodStart({ schedule: 'weekly', hour: 9, weekday: 0 }, now).toISOString()).toBe('2030-01-06T09:00:00.000Z');
  });
  it('crosses month and year boundaries', () => {
    expect(currentPeriodStart({ schedule: 'daily', hour: 8, weekday: null }, d('2031-01-01T03:00:00Z')).toISOString()).toBe('2030-12-31T08:00:00.000Z');
    expect(currentPeriodStart({ schedule: 'weekly', hour: 8, weekday: 5 }, d('2030-03-01T03:00:00Z')).toISOString()).toBe('2030-02-22T08:00:00.000Z');
  });
});

describe('isSubscriptionDue', () => {
  const now = d('2030-01-08T10:00:00Z');
  it('daily: due once the hour passes and nothing sent in the period', () => {
    expect(isSubscriptionDue(daily(8, null), now)).toBe(true);
    expect(isSubscriptionDue(daily(11, null), now)).toBe(true); // yesterday's slot was missed: caught up
    expect(isSubscriptionDue(daily(11, d('2030-01-07T11:01:00Z')), now)).toBe(false);
  });
  it('not due when already sent in the current period', () => {
    expect(isSubscriptionDue(daily(8, d('2030-01-08T08:03:00Z')), now)).toBe(false);
    expect(isSubscriptionDue(daily(8, d('2030-01-07T08:03:00Z')), now)).toBe(true);
  });
  it('new subscriptions wait for the next slot', () => {
    expect(isSubscriptionDue(daily(8, null, d('2030-01-08T09:00:00Z')), now)).toBe(false);
    expect(isSubscriptionDue(daily(8, null, d('2030-01-08T07:00:00Z')), now)).toBe(true);
    expect(isSubscriptionDue(daily(12, null, d('2030-01-08T00:00:00Z')), now)).toBe(false);
  });
  it('weekly', () => {
    expect(isSubscriptionDue(weekly(9, 2, null), now)).toBe(true);
    expect(isSubscriptionDue(weekly(9, 2, d('2030-01-08T09:05:00Z')), now)).toBe(false);
    expect(isSubscriptionDue(weekly(9, 2, d('2030-01-01T09:05:00Z')), now)).toBe(true);
    expect(isSubscriptionDue(weekly(9, 3, d('2030-01-02T09:05:00Z')), now)).toBe(false);
  });
  it('rejects malformed schedules', () => {
    expect(isSubscriptionDue({ ...daily(8, null), schedule: 'hourly' }, now)).toBe(false);
    expect(isSubscriptionDue(daily(24, null), now)).toBe(false);
    expect(isSubscriptionDue(daily(-1, null), now)).toBe(false);
    expect(isSubscriptionDue({ ...weekly(8, 1, null), weekday: null }, now)).toBe(false);
    expect(isSubscriptionDue(weekly(8, 7, null), now)).toBe(false);
  });
});
