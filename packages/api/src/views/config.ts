/**
 * Saved views: configuration model (pure, no database access).
 *
 * A view = query (JQL and/or simple filters) + layout + display properties (columns, order) + sort +
 * group by / sub-group by + "show empty groups". The configuration is stored as jsonb on `views.config`;
 * everything read back from storage goes through `normalizeConfig` so rows written by older code (or by hand)
 * never break the page.
 */
import { z } from 'zod';
import { MAX_JQL_LENGTH } from '../jql/autocomplete';

export const LAYOUTS = ['list', 'table', 'board', 'calendar', 'timeline'] as const;
export type Layout = (typeof LAYOUTS)[number];

export const GROUP_FIELDS = ['status', 'assignee', 'priority', 'type', 'label', 'sprint', 'none'] as const;
export type GroupField = (typeof GROUP_FIELDS)[number];

/** Columns a view may show and an export may contain. */
export const COLUMN_IDS = [
  'key', 'summary', 'type', 'status', 'priority', 'assignee', 'reporter', 'project', 'labels', 'components',
  'fixVersions', 'sprint', 'storyPoints', 'created', 'updated', 'resolved', 'resolution', 'duedate', 'startdate',
] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];
export const DEFAULT_COLUMNS: ColumnId[] = ['key', 'summary', 'type', 'status', 'priority', 'assignee', 'updated'];

/** Fields the result can be sorted by. */
export const SORT_FIELDS = [
  'key', 'summary', 'type', 'status', 'priority', 'assignee', 'reporter', 'project', 'storyPoints',
  'created', 'updated', 'resolved', 'duedate', 'startdate',
] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const CALENDAR_DATE_FIELDS = ['duedate', 'startdate', 'created', 'updated'] as const;

export const MAX_SORT_TERMS = 3;
export const MAX_FILTER_VALUES = 50;
const filterValue = z.string().trim().min(1).max(100);
const filterList = z.array(filterValue).max(MAX_FILTER_VALUES);

/** The "simple filters" form of a query; compiled to JQL by `buildFilterJql`. */
export const simpleFiltersSchema = z.object({
  projects: filterList.optional(),
  statuses: filterList.optional(),
  types: filterList.optional(),
  priorities: filterList.optional(),
  labels: filterList.optional(),
  /** a username, "me" or "unassigned" */
  assignee: filterValue.optional(),
  /** a username or "me" */
  reporter: filterValue.optional(),
  text: z.string().trim().min(1).max(200).optional(),
  resolution: z.enum(['open', 'resolved']).optional(),
}).strict();
export type SimpleFilters = z.infer<typeof simpleFiltersSchema>;

export const sortTermSchema = z.object({
  field: z.enum(SORT_FIELDS),
  direction: z.enum(['asc', 'desc']),
}).strict();
export type SortTerm = z.infer<typeof sortTermSchema>;

const querySchema = z.object({
  jql: z.string().max(MAX_JQL_LENGTH).default(''),
  filters: simpleFiltersSchema.optional(),
}).strict();

export const viewConfigSchema = z.object({
  query: querySchema.default({ jql: '' }),
  layout: z.enum(LAYOUTS).default('list'),
  columns: z.array(z.enum(COLUMN_IDS)).min(1).max(COLUMN_IDS.length).default(DEFAULT_COLUMNS),
  sort: z.array(sortTermSchema).max(MAX_SORT_TERMS).default([]),
  groupBy: z.enum(GROUP_FIELDS).default('none'),
  subGroupBy: z.enum(GROUP_FIELDS).default('none'),
  showEmptyGroups: z.boolean().default(false),
  /** Which date the calendar and timeline layouts use. */
  dateField: z.enum(CALENDAR_DATE_FIELDS).default('duedate'),
}).strict();
export type ViewConfig = z.infer<typeof viewConfigSchema>;

export function defaultConfig(): ViewConfig {
  return viewConfigSchema.parse({});
}

/** Removes duplicate columns/sort fields and a sub-group that equals the group or has no group (keeps the first). */
export function tidyConfig(c: ViewConfig): ViewConfig {
  const columns = [...new Set(c.columns)];
  const seen = new Set<string>();
  const sort = c.sort.filter((t) => (seen.has(t.field) ? false : (seen.add(t.field), true)));
  const subGroupBy = c.groupBy === 'none' || c.subGroupBy === c.groupBy ? 'none' : c.subGroupBy;
  return { ...c, columns, sort, subGroupBy };
}

/** Validates a client supplied configuration (strict). Returns an error message or the tidy config. */
export function parseConfig(raw: unknown): { ok: true; config: ViewConfig } | { ok: false; error: string } {
  const r = viewConfigSchema.safeParse(raw ?? {});
  if (!r.success) return { ok: false, error: `Invalid view configuration: ${r.error.issues[0]?.path.join('.') || 'config'}` };
  return { ok: true, config: tidyConfig(r.data) };
}

/** Reads a stored configuration leniently: unknown or invalid parts fall back to defaults, never throws. */
export function normalizeConfig(raw: unknown): ViewConfig {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = {}; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return defaultConfig();
  const strict = viewConfigSchema.safeParse(v);
  if (strict.success) return tidyConfig(strict.data);
  const src = v as Record<string, unknown>;
  const pick = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, fallback: T): T => {
    const r = schema.safeParse(value);
    return r.success ? r.data : fallback;
  };
  const def = defaultConfig();
  return tidyConfig({
    query: pick(querySchema, src.query, def.query),
    layout: pick(viewConfigSchema.shape.layout, src.layout, def.layout),
    columns: pick(viewConfigSchema.shape.columns, src.columns, def.columns),
    sort: pick(viewConfigSchema.shape.sort, src.sort, def.sort),
    groupBy: pick(viewConfigSchema.shape.groupBy, src.groupBy, def.groupBy),
    subGroupBy: pick(viewConfigSchema.shape.subGroupBy, src.subGroupBy, def.subGroupBy),
    showEmptyGroups: pick(viewConfigSchema.shape.showEmptyGroups, src.showEmptyGroups, def.showEmptyGroups),
    dateField: pick(viewConfigSchema.shape.dateField, src.dateField, def.dateField),
  });
}

/* ------------------------------------------------------------------ */
/*  Simple filters -> JQL                                              */
/* ------------------------------------------------------------------ */

/** Always quotes: values come from users and must never be able to inject JQL syntax. */
export function jqlString(v: string): string {
  return `"${v.replace(/["\\\r\n]/g, ' ').trim()}"`;
}

/**
 * Compiles the simple filters to a JQL condition (no ORDER BY). Empty filters give an empty string.
 * Every value is quoted, so a value such as `x" OR 1=1` stays one literal.
 */
export function buildFilterJql(f: SimpleFilters | undefined): string {
  if (!f) return '';
  const parts: string[] = [];
  const list = (field: string, values?: string[]) => {
    if (values && values.length) parts.push(`${field} in (${values.map(jqlString).join(', ')})`);
  };
  list('project', f.projects);
  list('status', f.statuses);
  list('issuetype', f.types);
  list('priority', f.priorities);
  list('labels', f.labels);
  const user = (field: string, v: string | undefined, allowUnassigned: boolean) => {
    if (!v) return;
    if (v.toLowerCase() === 'me') parts.push(`${field} = currentUser()`);
    else if (allowUnassigned && v.toLowerCase() === 'unassigned') parts.push(`${field} is EMPTY`);
    else parts.push(`${field} = ${jqlString(v)}`);
  };
  user('assignee', f.assignee, true);
  user('reporter', f.reporter, false);
  if (f.text) parts.push(`text ~ ${jqlString(f.text)}`);
  if (f.resolution === 'open') parts.push('resolution is EMPTY');
  if (f.resolution === 'resolved') parts.push('resolution is not EMPTY');
  return parts.join(' AND ');
}

/** Human readable one-line summary of a query, for lists and export headers. */
export function describeQuery(q: ViewConfig['query']): string {
  const f = buildFilterJql(q.filters);
  return [q.jql.trim(), f].filter(Boolean).join(' AND ') || 'All issues';
}

/* ------------------------------------------------------------------ */
/*  Built-in views                                                     */
/* ------------------------------------------------------------------ */

export interface BuiltinView { key: string; id: string; name: string; description: string; config: ViewConfig }

const mk = (key: string, name: string, description: string, patch: Partial<ViewConfig>): BuiltinView => ({
  key, id: `builtin:${key}`, name, description, config: tidyConfig({ ...defaultConfig(), ...patch }),
});

/** Generated on the fly, never stored, cannot be edited or deleted. */
export const BUILTIN_VIEWS: readonly BuiltinView[] = [
  mk('all-work', 'All work', 'Every issue you can browse, newest first.', { sort: [{ field: 'created', direction: 'desc' }] }),
  mk('assigned-to-me', 'Assigned to me', 'Unresolved issues assigned to you.', {
    query: { jql: 'assignee = currentUser() AND resolution is EMPTY' },
    sort: [{ field: 'updated', direction: 'desc' }],
  }),
  mk('created-by-me', 'Created by me', 'Issues you reported.', {
    query: { jql: 'reporter = currentUser()' },
    sort: [{ field: 'created', direction: 'desc' }],
  }),
  mk('recently-updated', 'Recently updated', 'Issues changed in the last 14 days.', {
    query: { jql: 'updated >= -14d' },
    sort: [{ field: 'updated', direction: 'desc' }],
  }),
];

export function getBuiltinView(key: string): BuiltinView | undefined {
  return BUILTIN_VIEWS.find((b) => b.key === key);
}
