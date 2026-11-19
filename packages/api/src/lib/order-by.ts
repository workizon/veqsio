import { asc, desc } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

export interface OrderTerm { col: string; dir: 'asc' | 'desc' }

/**
 * Parses `?orderBy=name:asc,email:desc` for list endpoints. Only columns in `allowed` are accepted (the value never
 * reaches SQL as text); unknown columns, bad directions and duplicates are dropped; at most 4 terms are used.
 */
export function parseOrderBy(raw: string | undefined | null, allowed: readonly string[]): OrderTerm[] {
  if (!raw) return [];
  const out: OrderTerm[] = [];
  for (const part of raw.split(',').slice(0, 8)) {
    const [col, d] = part.trim().split(':');
    if (!col || !allowed.includes(col) || out.some((t) => t.col === col)) continue;
    out.push({ col, dir: d?.toLowerCase() === 'desc' ? 'desc' : 'asc' });
    if (out.length === 4) break;
  }
  return out;
}

/** Builds ORDER BY terms from parsed input; `columns` maps each allowed name to a column or SQL expression. */
export function orderByClauses(terms: OrderTerm[], columns: Record<string, SQL | any>, fallback: (SQL | any)[]): (SQL | any)[] {
  if (!terms.length) return fallback;
  // the fallback goes last so equal rows keep a stable order across pages
  return [...terms.map((t) => (t.dir === 'desc' ? desc(columns[t.col]) : asc(columns[t.col]))), ...fallback];
}
