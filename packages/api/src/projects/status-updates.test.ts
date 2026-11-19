import { describe, expect, test } from 'bun:test';
import { badgeFor, latestOf, sortNewestFirst, statusUpdateBody, MAX_BODY } from './status-updates';

describe('status update helpers', () => {
  test('validates the body strictly', () => {
    expect(statusUpdateBody.safeParse({ state: 'on_track', body: 'All good' }).success).toBe(true);
    expect(statusUpdateBody.safeParse({ state: 'on_track' }).data?.body).toBe('');
    expect(statusUpdateBody.safeParse({ state: 'green' }).success).toBe(false);
    expect(statusUpdateBody.safeParse({ state: 'at_risk', extra: 1 }).success).toBe(false);
    expect(statusUpdateBody.safeParse({ state: 'at_risk', body: 'x'.repeat(MAX_BODY + 1) }).success).toBe(false);
  });

  test('newest first with a stable tie break, latest is the first', () => {
    const rows = [
      { id: 1, createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 3, createdAt: new Date('2026-01-02T00:00:00Z') },
      { id: 2, createdAt: '2026-01-02T00:00:00Z' },
    ];
    expect(sortNewestFirst(rows).map((r) => r.id)).toEqual([3, 2, 1]);
    expect(latestOf(rows)?.id).toBe(3);
    expect(latestOf([])).toBeNull();
  });

  test('badge colours', () => {
    expect(badgeFor('on_track').label).toBe('On track');
    expect(badgeFor('at_risk').color).not.toBe(badgeFor('off_track').color);
    expect(badgeFor('weird').label).toBe('weird');
  });
});
