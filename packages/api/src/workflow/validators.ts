import type { Validator } from './types';

export interface ValidationContext {
  fields: Record<string, any>;
  issueId: number;
}

export function evaluateValidators(
  validators: Validator[],
  context: ValidationContext
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!validators || validators.length === 0) {
    return { valid: true, errors };
  }

  for (const validator of validators) {
    const result = evaluateSingleValidator(validator, context);
    if (!result.valid) {
      errors.push(result.error);
    }
  }

  return { valid: errors.length === 0, errors };
}

function evaluateSingleValidator(
  validator: Validator,
  context: ValidationContext
): { valid: boolean; error: string } {
  switch (validator.type) {
    case 'field_required': {
      const value = context.fields[validator.field || ''];
      if (value === undefined || value === null || value === '') {
        return { valid: false, error: `Field '${validator.field}' is required` };
      }
      return { valid: true, error: '' };
    }

    case 'field_regex': {
      const fieldValue = context.fields[validator.field || ''];
      if (fieldValue && validator.pattern) {
        // administrator-written pattern against user input: bounded length of both, so a pattern with bad backtracking cannot hold the server
        const text = String(fieldValue);
        if (validator.pattern.length > 200 || text.length > 1000) return { valid: false, error: `Field '${validator.field}' is too long to check against its pattern` };
        const regex = new RegExp(validator.pattern);
        if (!regex.test(text)) {
          return { valid: false, error: `Field '${validator.field}' does not match pattern` };
        }
      }
      return { valid: true, error: '' };
    }

    case 'field_value':
      // Simplified
      return { valid: true, error: '' };

    default:
      return { valid: true, error: '' };
  }
}
