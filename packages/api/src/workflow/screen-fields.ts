/**
 * Transition screens: which fields a screen can hold and how the values sent with a transition are parsed.
 * Pure (no database): the engine loads the screen, calls parseScreenInput, checks the referenced ids and applies
 * `update` through the normal issue edit code in the transition's transaction.
 */
import { validateStoryPoints } from '../issues/service';
import type { UpdateIssueRequest } from '../issues/types';
import { parseResolutionInput } from './transition-meta';

export type ScreenFieldType =
  | 'resolution' | 'user' | 'priority' | 'labels' | 'versions' | 'components' | 'date' | 'number' | 'text' | 'comment'
  // custom field kinds
  | 'string' | 'textarea' | 'select' | 'multiselect' | 'boolean' | 'url' | 'datetime' | 'userpicker' | 'other';

/** System fields a screen may contain (key = Jira field id used in the REST payload). */
export const SYSTEM_SCREEN_FIELDS: ReadonlyArray<{ key: string; name: string; type: ScreenFieldType }> = [
  { key: 'resolution', name: 'Resolution', type: 'resolution' },
  { key: 'assignee', name: 'Assignee', type: 'user' },
  { key: 'priority', name: 'Priority', type: 'priority' },
  { key: 'labels', name: 'Labels', type: 'labels' },
  { key: 'fixVersions', name: 'Fix versions', type: 'versions' },
  { key: 'components', name: 'Components', type: 'components' },
  { key: 'duedate', name: 'Due date', type: 'date' },
  { key: 'storyPoints', name: 'Story points', type: 'number' },
  { key: 'environment', name: 'Environment', type: 'text' },
  { key: 'comment', name: 'Comment', type: 'comment' },
];

export const SYSTEM_SCREEN_FIELD_KEYS = new Set(SYSTEM_SCREEN_FIELDS.map((f) => f.key));

export interface ScreenFieldDef {
  key: string;
  name: string;
  type: ScreenFieldType;
  custom: boolean;
  customId?: number;
  required: boolean;
  /** Allowed values of a select-like custom field. */
  options?: string[];
}

export interface ParsedScreenInput {
  update: UpdateIssueRequest;
  /** Value for the comment field (handled by the transition itself). */
  comment?: string;
  errors: Record<string, string>;
  /** References that must exist (checked against the database by the caller). */
  refs: { assigneeId?: number; priorityId?: number; componentIds?: number[]; versionIds?: number[] };
}

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

function idOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string') return /^\d{1,9}$/.test(v) ? Number(v) : null;
  if (v && typeof v === 'object' && 'id' in (v as object)) return idOf((v as { id: unknown }).id);
  return null;
}

function idList(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) {
    const id = idOf(x);
    if (id === null) return null;
    out.push(id);
  }
  return [...new Set(out)];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/**
 * Validate the values sent for a screen. `input` is the `fields` object of the transition request (Jira shapes:
 * assignee {id}, priority {id}, labels [..], components/fixVersions [{id}], duedate "YYYY-MM-DD", customfield_N value).
 * `hasCurrent(key)` says whether the issue already has a value, so a required field the caller leaves out is fine then.
 */
export function parseScreenInput(defs: ScreenFieldDef[], input: Record<string, any>, hasCurrent: (key: string) => boolean): ParsedScreenInput {
  const out: ParsedScreenInput = { update: {}, errors: {}, refs: {} };
  const customUpdates: Array<{ fieldId: number; value: any }> = [];
  for (const d of defs) {
    const provided = Object.prototype.hasOwnProperty.call(input, d.key) && input[d.key] !== undefined;
    const raw = provided ? input[d.key] : undefined;
    const fail = (msg: string) => { out.errors[d.key] = msg; };
    if (!provided) {
      if (d.required && !hasCurrent(d.key)) fail(`${d.name} is required`);
      continue;
    }
    if (d.required && (isEmpty(raw) || (d.type === 'resolution' && parseResolutionInput(raw) === null))) {
      fail(`${d.name} is required`);
      continue;
    }
    if (d.custom) {
      (() => {
        if (d.customId === undefined) return;
        const clear = isEmpty(raw);
        let value: unknown = raw;
        if (!clear) {
          switch (d.type) {
            case 'number': {
              const n = typeof raw === 'string' ? Number(raw.replace(',', '.')) : raw;
              if (typeof n !== 'number' || !Number.isFinite(n)) { fail(`${d.name} must be a number`); return; }
              value = n; break;
            }
            case 'date': case 'datetime': {
              if (typeof raw !== 'string' || Number.isNaN(new Date(raw).getTime())) { fail(`${d.name} must be a date`); return; }
              value = raw; break;
            }
            case 'boolean': value = raw === true || raw === 'true'; break;
            case 'select': {
              const s = String(raw);
              if (d.options && d.options.length > 0 && !d.options.includes(s)) { fail(`${d.name} must be one of the listed options`); return; }
              value = s; break;
            }
            default: {
              const s = String(raw);
              if (s.length > 500) { fail(`${d.name} is too long (500 characters at most)`); return; }
              value = s;
            }
          }
        } else value = null;
        customUpdates.push({ fieldId: d.customId, value });
      })();
      continue;
    }
    switch (d.type) {
      case 'resolution': break; // parsed and looked up by the transition
      case 'comment': {
        if (raw !== null && typeof raw !== 'string') { fail('Comment must be text'); break; }
        const t = (raw ?? '').trim();
        if (t.length > 100000) fail('Comment is too long');
        else if (t) out.comment = t;
        break;
      }
      case 'user': {
        if (isEmpty(raw)) { out.update.assigneeId = null; break; }
        const id = idOf(raw);
        if (id === null) fail('Assignee is not a valid user');
        else { out.update.assigneeId = id; out.refs.assigneeId = id; }
        break;
      }
      case 'priority': {
        if (isEmpty(raw)) { fail('Priority cannot be cleared'); break; }
        const id = idOf(raw);
        if (id === null) fail('Priority is not valid');
        else { out.update.priorityId = id; out.refs.priorityId = id; }
        break;
      }
      case 'labels': {
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) { fail('Labels must be a list of text values'); break; }
        const labels = [...new Set((raw as string[]).map((x) => x.trim()).filter(Boolean))];
        if (labels.some((l) => l.length > 255 || /\s/.test(l))) fail('Labels cannot contain spaces or be longer than 255 characters');
        else out.update.labels = labels;
        break;
      }
      case 'versions': {
        const ids = isEmpty(raw) ? [] : idList(raw);
        if (ids === null) fail('Fix versions are not valid');
        else { out.update.fixVersions = ids; out.refs.versionIds = ids; }
        break;
      }
      case 'components': {
        const ids = isEmpty(raw) ? [] : idList(raw);
        if (ids === null) fail('Components are not valid');
        else { out.update.components = ids; out.refs.componentIds = ids; }
        break;
      }
      case 'date': {
        if (isEmpty(raw)) { out.update.dueDate = null; break; }
        if (typeof raw !== 'string' || !validDate(raw)) fail('Due date must be a date (YYYY-MM-DD)');
        else out.update.dueDate = raw;
        break;
      }
      case 'number': {
        if (isEmpty(raw)) { out.update.storyPoints = null; break; }
        try { out.update.storyPoints = validateStoryPoints(typeof raw === 'string' ? Number(raw.replace(',', '.')) : raw); } catch (e: any) { fail(e.message); }
        break;
      }
      case 'text': {
        if (raw !== null && typeof raw !== 'string') { fail(`${d.name} must be text`); break; }
        if ((raw ?? '').length > 10000) fail(`${d.name} is too long`);
        else out.update.environment = raw ?? '';
        break;
      }
      default: break;
    }
  }
  if (customUpdates.length) out.update.customFields = customUpdates;
  return out;
}

/** Map a custom field type (custom_fields.field_type) to the kind used on a screen. */
export function customScreenType(fieldType: string): ScreenFieldType {
  switch (fieldType) {
    case 'number': return 'number';
    case 'date': return 'date';
    case 'datetime': return 'datetime';
    case 'select': case 'radio': return 'select';
    case 'checkbox': return 'boolean';
    case 'textarea': return 'textarea';
    case 'url': return 'url';
    default: return 'string';
  }
}
