import { isDoneLike } from '../workflow/status-groups';
/**
 * Pure label rules: palette, colour and name validation, merge planning and the
 * "remove on resolution" decision. No database access here so it is unit-testable.
 */

/** Palette tokens. The web app owns the actual CSS variables for each token (light and dark). */
export const LABEL_PALETTE = [
  'gray',
  'red',
  'orange',
  'amber',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'violet',
  'pink',
] as const;

export type LabelPaletteToken = (typeof LABEL_PALETTE)[number];

export const MAX_LABEL_NAME_LENGTH = 100;

const HEX_RE = /^#[0-9a-f]{6}$/i;

export type ColorResult = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Accepts a palette token, a '#rrggbb' hex (3-digit shorthand is expanded) or null/'' (reset to default).
 * Hex values are stored lower-case so equal colours compare equal.
 */
export function validateLabelColor(input: unknown): ColorResult {
  if (input === null || input === undefined || input === '') return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false, error: 'Colour must be a string' };
  const raw = input.trim();
  const lower = raw.toLowerCase();
  if ((LABEL_PALETTE as readonly string[]).includes(lower)) return { ok: true, value: lower };
  let hex = raw;
  if (/^#[0-9a-f]{3}$/i.test(hex)) hex = '#' + hex.slice(1).split('').map((ch) => ch + ch).join('');
  if (HEX_RE.test(hex)) return { ok: true, value: hex.toLowerCase() };
  return { ok: false, error: `Colour must be one of ${LABEL_PALETTE.join(', ')} or a #rrggbb hex value` };
}

export type NameResult = { ok: true; value: string } | { ok: false; error: string };

/** Trims and validates a label name. Commas are rejected because they separate labels in CSV and form input. */
export function validateLabelName(input: unknown): NameResult {
  if (typeof input !== 'string') return { ok: false, error: 'Label name must be a string' };
  const value = input.trim().replace(/\s+/g, ' ');
  if (!value) return { ok: false, error: 'Label name must not be empty' };
  if (value.length > MAX_LABEL_NAME_LENGTH) return { ok: false, error: `Label name must be at most ${MAX_LABEL_NAME_LENGTH} characters` };
  if (value.includes(',')) return { ok: false, error: 'Label name must not contain commas' };
  return { ok: true, value };
}

export interface MergePlan {
  /** Issues that carry the source label only: they get the target label attached. */
  attachToIssueIds: number[];
  /** Issues that already carry both: only the source link is dropped. */
  alreadyHaveTarget: number[];
}

/** Which issues need re-pointing when `source` is merged into `target`. */
export function planLabelMerge(sourceIssueIds: number[], targetIssueIds: number[]): MergePlan {
  const target = new Set(targetIssueIds);
  const attachToIssueIds: number[] = [];
  const alreadyHaveTarget: number[] = [];
  for (const id of new Set(sourceIssueIds)) {
    (target.has(id) ? alreadyHaveTarget : attachToIssueIds).push(id);
  }
  return { attachToIssueIds, alreadyHaveTarget };
}

/** An issue counts as resolved once it sits in a done-category status or carries a resolution. */
export function isResolvedState(statusCategory: string | null | undefined, resolutionId: number | null | undefined): boolean {
  return isDoneLike(statusCategory) || (resolutionId !== null && resolutionId !== undefined);
}

/** Labels that must be detached when an issue becomes resolved. */
export function labelsToDetach<T extends { removeOnResolve: boolean }>(labels: T[]): T[] {
  return labels.filter((l) => l.removeOnResolve);
}

export interface LabelDetail {
  name: string;
  color: string | null;
  removeOnResolve: boolean;
}
