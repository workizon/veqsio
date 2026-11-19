import { describe, expect, test } from 'bun:test';
import { mapStatus } from './move-issue';

describe('move: status mapping', () => {
  test('keeps the current status when the target workflow has it', () => {
    expect(mapStatus(3, [1, 2, 3, 4], 1)).toEqual({ id: 3, needsMapping: false });
  });
  test('asks for a status when the target workflow does not have the current one', () => {
    expect(mapStatus(9, [1, 2, 3], 1)).toEqual({ id: null, needsMapping: true });
  });
  test('uses the chosen status when it belongs to the target workflow', () => {
    expect(mapStatus(9, [1, 2, 3], 1, 2)).toEqual({ id: 2, needsMapping: true });
    expect(mapStatus(9, [1, 2, 3], 1, 7)).toEqual({ id: null, needsMapping: true });
  });
  test('no workflow: nothing to map', () => {
    expect(mapStatus(9, [], null)).toEqual({ id: 9, needsMapping: false });
  });
});
