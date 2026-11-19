import { describe, test, expect } from 'bun:test';
import { evaluateValidators } from './validators';
import type { ValidationContext } from './validators';
import type { Validator } from './types';

describe('Workflow Validators', () => {
  test('empty validators pass', () => {
    const result = evaluateValidators([], { fields: {}, issueId: 1 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('field_required fails when missing', () => {
    const validators: Validator[] = [{ type: 'field_required', field: 'summary' }];
    const context: ValidationContext = { fields: {}, issueId: 1 };
    const result = evaluateValidators(validators, context);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Field 'summary' is required");
  });

  test('field_required passes when present', () => {
    const validators: Validator[] = [{ type: 'field_required', field: 'summary' }];
    const context: ValidationContext = { fields: { summary: 'Hello' }, issueId: 1 };
    const result = evaluateValidators(validators, context);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('field_required fails on empty string', () => {
    const validators: Validator[] = [{ type: 'field_required', field: 'summary' }];
    const context: ValidationContext = { fields: { summary: '' }, issueId: 1 };
    const result = evaluateValidators(validators, context);
    expect(result.valid).toBe(false);
  });

  test('field_required fails on null', () => {
    const validators: Validator[] = [{ type: 'field_required', field: 'summary' }];
    const context: ValidationContext = { fields: { summary: null }, issueId: 1 };
    const result = evaluateValidators(validators, context);
    expect(result.valid).toBe(false);
  });

  test('field_regex fails on mismatch', () => {
    const validators: Validator[] = [{ type: 'field_regex', field: 'key', pattern: '^[A-Z]+$' }];
    const context: ValidationContext = { fields: { key: 'abc' }, issueId: 1 };
    const result = evaluateValidators(validators, context);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Field 'key' does not match pattern");
  });

  test('field_regex passes on match', () => {
    const validators: Validator[] = [{ type: 'field_regex', field: 'key', pattern: '^[A-Z]+$' }];
    const context: ValidationContext = { fields: { key: 'ABC' }, issueId: 1 };
    const result = evaluateValidators(validators, context);
    expect(result.valid).toBe(true);
  });

  test('field_regex passes when field is missing and pattern is not required', () => {
    const validators: Validator[] = [{ type: 'field_regex', field: 'key', pattern: '^[A-Z]+$' }];
    const context: ValidationContext = { fields: {}, issueId: 1 };
    const result = evaluateValidators(validators, context);
    expect(result.valid).toBe(true);
  });

  test('multiple validators aggregate errors', () => {
    const validators: Validator[] = [
      { type: 'field_required', field: 'summary' },
      { type: 'field_required', field: 'description' },
    ];
    const context: ValidationContext = { fields: {}, issueId: 1 };
    const result = evaluateValidators(validators, context);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
  });
});
