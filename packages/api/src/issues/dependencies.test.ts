import { describe, expect, test } from 'bun:test';
import { dependencyConflict, wouldCreateCycle } from './dependencies';

const D = (s: string) => Date.parse(`${s}T00:00:00Z`);

describe('wouldCreateCycle', () => {
  const edges = [{ predecessor: 1, successor: 2 }, { predecessor: 2, successor: 3 }, { predecessor: 4, successor: 3 }];
  test('detects direct, indirect and self cycles', () => {
    expect(wouldCreateCycle(edges, 2, 1)).toBe(true); // 1 -> 2 exists
    expect(wouldCreateCycle(edges, 3, 1)).toBe(true); // 1 -> 2 -> 3
    expect(wouldCreateCycle(edges, 5, 5)).toBe(true);
  });
  test('allows acyclic additions, including diamonds', () => {
    expect(wouldCreateCycle(edges, 1, 3)).toBe(false);
    expect(wouldCreateCycle(edges, 3, 5)).toBe(false);
    expect(wouldCreateCycle(edges, 4, 2)).toBe(false);
    expect(wouldCreateCycle([], 1, 2)).toBe(false);
  });
});

describe('dependencyConflict', () => {
  test('finishes-before warns when the predecessor ends after the successor starts', () => {
    expect(dependencyConflict('finishes_before', { start: D('2026-01-01'), end: D('2026-02-10') }, { start: D('2026-02-01'), end: null }).conflict).toBe(true);
    expect(dependencyConflict('finishes_before', { start: null, end: D('2026-02-01') }, { start: D('2026-02-01'), end: null }).conflict).toBe(false); // same day is fine
  });
  test('starts-before compares the start dates', () => {
    expect(dependencyConflict('starts_before', { start: D('2026-03-01'), end: null }, { start: D('2026-02-01'), end: null }).conflict).toBe(true);
    expect(dependencyConflict('starts_before', { start: D('2026-01-01'), end: D('2026-09-01') }, { start: D('2026-02-01'), end: null }).conflict).toBe(false);
  });
  test('missing dates never conflict', () => {
    expect(dependencyConflict('finishes_before', { start: null, end: null }, { start: D('2026-02-01'), end: null }).conflict).toBe(false);
    expect(dependencyConflict('finishes_before', { start: null, end: D('2026-05-01') }, { start: null, end: null }).conflict).toBe(false);
  });
});
