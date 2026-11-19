import type { Validator, PostFunction } from './types';
import { baseCategory } from './status-groups';

/** Normalise the many spellings of a status category to the classic three buckets (backlog = todo, cancelled = done); see status-groups.ts. */
export function normalizeCategory(category: string | null | undefined): 'todo' | 'in_progress' | 'done' {
  return baseCategory(category);
}

export interface TransitionMeta {
  /** Field names that validators require to be present on submit. */
  requiredFields: string[];
  /** True when the UI must ask for a resolution (done-category target and nothing sets it automatically). */
  requiresResolution: boolean;
  /** True when a validator requires a comment. */
  requiresComment: boolean;
  /** True when the user has to provide input before the transition can run. */
  requiresInput: boolean;
}

/**
 * Derive what the UI has to ask for from a transition definition. Pure, so it is unit tested without a DB.
 * `comment` / `resolution` validators map to the dedicated dialog inputs; `hasScreen` always requires input.
 */
export function buildTransitionMeta(
  validators: Validator[] | null | undefined,
  postFunctions: PostFunction[] | null | undefined,
  toCategory: string | null | undefined,
  hasScreen: boolean,
): TransitionMeta {
  const requiredFields = [
    ...new Set(
      (validators || [])
        .filter((v) => v && v.type === 'field_required' && v.field)
        .map((v) => String(v.field)),
    ),
  ];
  const setsResolution = (postFunctions || []).some((p) => p && p.type === 'set_resolution' && p.resolution_id != null);
  const requiresResolution =
    requiredFields.includes('resolution') || (normalizeCategory(toCategory) === 'done' && !setsResolution);
  const requiresComment = requiredFields.includes('comment');
  const otherRequired = requiredFields.filter((f) => f !== 'resolution' && f !== 'comment');
  return {
    requiredFields,
    requiresResolution,
    requiresComment,
    requiresInput: hasScreen || requiresResolution || requiresComment || otherRequired.length > 0,
  };
}

/** Accepts `{id}`, a numeric id, or a name; returns what is needed to look the resolution up. */
export function parseResolutionInput(value: unknown): { id?: number; name?: string } | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') {
    const v = value as { id?: unknown; name?: unknown };
    if (v.id !== undefined && v.id !== null && v.id !== '' && Number.isFinite(Number(v.id))) return { id: Number(v.id) };
    if (typeof v.name === 'string' && v.name) return { name: v.name };
    return null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? { id: value } : null;
  if (typeof value === 'string') return /^\d+$/.test(value) ? { id: Number(value) } : { name: value };
  return null;
}

/** Thrown by doTransition when validators fail; `errors` carries one message per failed validator. */
export class TransitionValidationError extends Error {
  errors: string[];
  /** Per-field messages (field key -> message) for transition screen fields. */
  fieldErrors: Record<string, string>;
  constructor(errors: string[], fieldErrors: Record<string, string> = {}) {
    super(`Validation failed: ${errors.join(', ')}`);
    this.name = 'TransitionValidationError';
    this.errors = errors;
    this.fieldErrors = fieldErrors;
  }
}
