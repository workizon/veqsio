import { describe, it, expect } from 'bun:test';
import { onCallAt, shiftsBetween, rotationUserAt } from './rotation';

const d = (s: string) => new Date(s);
const r = { memberIds: [1, 2, 3], startAt: d('2026-01-05T00:00:00Z'), rotationHours: 24 };

describe('rotation', () => {
  it('rotates members and wraps around', () => {
    expect(rotationUserAt(r, d('2026-01-05T10:00:00Z'))).toBe(1);
    expect(rotationUserAt(r, d('2026-01-06T00:00:00Z'))).toBe(2);
    expect(rotationUserAt(r, d('2026-01-08T00:00:00Z'))).toBe(1);
  });
  it('nobody before the start or without members', () => {
    expect(rotationUserAt(r, d('2026-01-04T23:59:59Z'))).toBeNull();
    expect(rotationUserAt({ ...r, memberIds: [] }, d('2026-02-01T00:00:00Z'))).toBeNull();
  });
  it('an override replaces the rotation for its window only; the latest start wins', () => {
    const o = [{ userId: 9, startsAt: d('2026-01-05T06:00:00Z'), endsAt: d('2026-01-05T12:00:00Z') }, { userId: 8, startsAt: d('2026-01-05T08:00:00Z'), endsAt: d('2026-01-05T10:00:00Z') }];
    expect(onCallAt(r, o, d('2026-01-05T05:59:00Z'))).toEqual({ userId: 1, override: false });
    expect(onCallAt(r, o, d('2026-01-05T07:00:00Z'))).toEqual({ userId: 9, override: true });
    expect(onCallAt(r, o, d('2026-01-05T09:00:00Z'))).toEqual({ userId: 8, override: true });
    expect(onCallAt(r, o, d('2026-01-05T12:00:00Z'))).toEqual({ userId: 1, override: false });
  });
  it('lists shifts with overrides cut in and merges equal neighbours', () => {
    const o = [{ userId: 9, startsAt: d('2026-01-05T12:00:00Z'), endsAt: d('2026-01-06T12:00:00Z') }];
    const s = shiftsBetween(r, o, d('2026-01-05T00:00:00Z'), d('2026-01-07T00:00:00Z'));
    expect(s.map((x) => [x.userId, x.from.toISOString(), x.to.toISOString(), x.override])).toEqual([
      [1, '2026-01-05T00:00:00.000Z', '2026-01-05T12:00:00.000Z', false],
      [9, '2026-01-05T12:00:00.000Z', '2026-01-06T12:00:00.000Z', true],
      [2, '2026-01-06T12:00:00.000Z', '2026-01-07T00:00:00.000Z', false],
    ]);
  });
  it('starts a window in the middle of a shift', () => {
    const s = shiftsBetween(r, [], d('2026-01-05T18:00:00Z'), d('2026-01-06T06:00:00Z'));
    expect(s.map((x) => x.userId)).toEqual([1, 2]);
  });
});

import { nextInRotation } from './rotation';
describe('nextInRotation', () => {
  it('wraps and needs a second person', () => {
    expect(nextInRotation([1, 2, 3], 3)).toBe(1);
    expect(nextInRotation([1, 2, 3], 1)).toBe(2);
    expect(nextInRotation([1], 1)).toBeNull();
    expect(nextInRotation([1, 2], null)).toBe(1);
  });
});
