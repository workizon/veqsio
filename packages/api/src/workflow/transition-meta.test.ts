import { describe, test, expect } from 'bun:test';
import { buildTransitionMeta, normalizeCategory, parseResolutionInput, TransitionValidationError } from './transition-meta';

describe('normalizeCategory', () => {
  test('maps spellings', () => {
    expect(normalizeCategory('todo')).toBe('todo');
    expect(normalizeCategory('to_do')).toBe('todo');
    expect(normalizeCategory('To Do')).toBe('todo');
    expect(normalizeCategory('in_progress')).toBe('in_progress');
    expect(normalizeCategory('indeterminate')).toBe('in_progress');
    expect(normalizeCategory('done')).toBe('done');
    expect(normalizeCategory(null)).toBe('todo');
  });
});

describe('buildTransitionMeta', () => {
  test('plain transition needs no input', () => {
    const m = buildTransitionMeta([], [], 'in_progress', false);
    expect(m).toEqual({ requiredFields: [], requiresResolution: false, requiresComment: false, requiresInput: false });
  });
  test('done target asks for resolution unless a post-function sets it', () => {
    expect(buildTransitionMeta([], [], 'done', false).requiresResolution).toBe(true);
    expect(buildTransitionMeta([], [{ type: 'set_resolution', resolution_id: 1 }], 'done', false).requiresResolution).toBe(false);
  });
  test('validators drive required fields and comment', () => {
    const m = buildTransitionMeta(
      [{ type: 'field_required', field: 'comment' }, { type: 'field_required', field: 'environment' }, { type: 'field_regex', field: 'x', pattern: '.' }],
      [],
      'in_progress',
      false,
    );
    expect(m.requiredFields).toEqual(['comment', 'environment']);
    expect(m.requiresComment).toBe(true);
    expect(m.requiresInput).toBe(true);
  });
  test('screen always needs input', () => {
    expect(buildTransitionMeta(null, null, 'todo', true).requiresInput).toBe(true);
  });
});

describe('parseResolutionInput', () => {
  test('accepts object, number, numeric string and name', () => {
    expect(parseResolutionInput({ id: '3' })).toEqual({ id: 3 });
    expect(parseResolutionInput(4)).toEqual({ id: 4 });
    expect(parseResolutionInput('5')).toEqual({ id: 5 });
    expect(parseResolutionInput('Fixed')).toEqual({ name: 'Fixed' });
    expect(parseResolutionInput({ name: 'Done' })).toEqual({ name: 'Done' });
    expect(parseResolutionInput(null)).toBeNull();
    expect(parseResolutionInput('')).toBeNull();
  });
});

describe('TransitionValidationError', () => {
  test('keeps legacy message format and individual errors', () => {
    const e = new TransitionValidationError(['a', 'b']);
    expect(e.message).toBe('Validation failed: a, b');
    expect(e.errors).toEqual(['a', 'b']);
  });
});
