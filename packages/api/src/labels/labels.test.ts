import { describe, test, expect } from 'bun:test';
import { LABEL_PALETTE, validateLabelColor, validateLabelName, planLabelMerge, isResolvedState, labelsToDetach } from './labels';

describe('validateLabelColor', () => {
  test('accepts every palette token, case-insensitively', () => {
    for (const t of LABEL_PALETTE) expect(validateLabelColor(t)).toEqual({ ok: true, value: t });
    expect(validateLabelColor(' Blue ')).toEqual({ ok: true, value: 'blue' });
  });
  test('has about twelve tokens', () => {
    expect(LABEL_PALETTE.length).toBe(12);
  });
  test('accepts hex, normalises case and expands shorthand', () => {
    expect(validateLabelColor('#AABBCC')).toEqual({ ok: true, value: '#aabbcc' });
    expect(validateLabelColor('#0af')).toEqual({ ok: true, value: '#00aaff' });
  });
  test('null, undefined and empty reset to the default', () => {
    expect(validateLabelColor(null)).toEqual({ ok: true, value: null });
    expect(validateLabelColor(undefined)).toEqual({ ok: true, value: null });
    expect(validateLabelColor('')).toEqual({ ok: true, value: null });
  });
  test('rejects junk, css injection and wrong types', () => {
    for (const bad of ['purple', '#12345', '#gggggg', 'red;background:url(x)', 'rgb(1,2,3)', '#1234567', 42, {}, ['red']]) {
      expect(validateLabelColor(bad).ok).toBe(false);
    }
  });
});

describe('validateLabelName', () => {
  test('trims and collapses whitespace', () => {
    expect(validateLabelName('  needs   review ')).toEqual({ ok: true, value: 'needs review' });
  });
  test('rejects empty, commas, too long and non-strings', () => {
    expect(validateLabelName('   ').ok).toBe(false);
    expect(validateLabelName('a,b').ok).toBe(false);
    expect(validateLabelName('x'.repeat(101)).ok).toBe(false);
    expect(validateLabelName('x'.repeat(100)).ok).toBe(true);
    expect(validateLabelName(5).ok).toBe(false);
  });
});

describe('planLabelMerge', () => {
  test('splits issues into attach and already-have-target', () => {
    expect(planLabelMerge([1, 2, 3], [3, 4])).toEqual({ attachToIssueIds: [1, 2], alreadyHaveTarget: [3] });
  });
  test('handles empty sides and duplicates', () => {
    expect(planLabelMerge([], [1])).toEqual({ attachToIssueIds: [], alreadyHaveTarget: [] });
    expect(planLabelMerge([5, 5], [])).toEqual({ attachToIssueIds: [5], alreadyHaveTarget: [] });
  });
});

describe('resolution rules', () => {
  test('done category or a resolution means resolved', () => {
    expect(isResolvedState('done', null)).toBe(true);
    expect(isResolvedState('Done', null)).toBe(true);
    expect(isResolvedState('in_progress', 3)).toBe(true);
    expect(isResolvedState('in_progress', null)).toBe(false);
    expect(isResolvedState(undefined, undefined)).toBe(false);
  });
  test('only flagged labels are detached', () => {
    const ls = [{ n: 'a', removeOnResolve: true }, { n: 'b', removeOnResolve: false }];
    expect(labelsToDetach(ls).map((l) => l.n)).toEqual(['a']);
  });
});
