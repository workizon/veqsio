/**
 * Cell escaping and CSV / JSON serialisation for view exports (pure).
 *
 * Formula injection: a text cell that starts with = + - @ (or a tab / carriage return, which some spreadsheet
 * programs strip before evaluating) is prefixed with an apostrophe so it is read as text, never as a formula.
 * Real numbers are written as numbers and are not touched.
 */
import type { CellValue } from './columns';

export const EXPORT_MAX_ROWS = 10_000;
/** The row cap; `VIEWS_EXPORT_MAX_ROWS` can only lower it (used by tests and to protect small installations). */
export function exportMaxRows(): number {
  const n = Number(process.env.VIEWS_EXPORT_MAX_ROWS);
  return Number.isInteger(n) && n >= 1 && n <= EXPORT_MAX_ROWS ? n : EXPORT_MAX_ROWS;
}
export const EXPORT_CHUNK = 500;
export const EXPORT_FORMATS = ['csv', 'xlsx', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Characters that cannot be stored in XLSX/XML 1.0 text (C0 controls other than tab, LF, CR). */
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** A cell as text: lists are joined with ", ", dates are ISO strings, null is empty. */
export function cellText(v: CellValue | Date | boolean | undefined): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** A safe cell for CSV/XLSX: numbers stay numbers, everything else becomes neutralised text without control chars. */
export function safeCell(v: CellValue | Date | boolean | undefined): string | number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = cellText(v).replace(INVALID_XML, '');
  return t === '' ? null : neutralizeFormula(t);
}

export function csvField(v: CellValue | Date | boolean | undefined): string {
  const c = safeCell(v);
  if (c === null) return '';
  const s = String(c);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: Array<CellValue | Date | boolean | undefined>): string {
  return cells.map(csvField).join(',') + '\r\n';
}

/** Header cells are fixed strings from our own tables, but go through the same escaping. */
export function csvHeader(headers: string[]): string {
  return csvLine(headers);
}

/** Safe file name for Content-Disposition: ASCII letters, digits, dash and underscore only. */
export function exportFileName(name: string, ext: string, now = new Date()): string {
  const base = name.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export';
  return `${base}-${now.toISOString().slice(0, 10)}.${ext}`;
}

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json; charset=utf-8',
};
