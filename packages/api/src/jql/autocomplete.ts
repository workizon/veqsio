/**
 * Pure JQL autocomplete logic: field metadata, context detection (what is being typed at the cursor)
 * and query validation with positions. No database access here; value suggestions live in
 * `suggestions.ts` and are combined with this module by the route.
 */
import { tokenize } from './lexer';
import { parseJQLTokens } from './parser';
import { JQLError } from './types';
import type { JQLNode, JQLValue, Token } from './types';

/* ------------------------------------------------------------------ */
/*  Field / operator / function metadata                               */
/* ------------------------------------------------------------------ */

export type FieldKind = 'text' | 'option' | 'user' | 'date' | 'number' | 'multi' | 'key';

export interface JqlFieldDef {
  value: string;
  displayName: string;
  orderable: boolean;
  searchable: boolean;
  kind: FieldKind;
  operators: string[];
}

const OPS_EQUALITY = ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'];
const OPS_OPTION = [...OPS_EQUALITY, 'WAS', 'WAS IN', 'WAS NOT IN', 'CHANGED'];
const OPS_TEXT = ['~', '!~', 'IS', 'IS NOT'];
const OPS_DATE = ['=', '!=', '>', '>=', '<', '<=', 'IS', 'IS NOT'];
const OPS_NUMBER = ['=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN', 'IS', 'IS NOT'];
const OPS_MULTI = ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'];

function f(value: string, displayName: string, kind: FieldKind, operators: string[], orderable: boolean): JqlFieldDef {
  return { value, displayName, kind, operators, orderable, searchable: true };
}

/** Must stay in sync with VALID_FIELDS in translator.ts. */
export const JQL_FIELDS: JqlFieldDef[] = [
  f('assignee', 'Assignee', 'user', OPS_OPTION, true),
  f('components', 'Component', 'multi', OPS_MULTI, false),
  f('created', 'Created', 'date', OPS_DATE, true),
  f('description', 'Description', 'text', OPS_TEXT, true),
  f('duedate', 'Due Date', 'date', OPS_DATE, true),
  f('fixversion', 'Fix Version', 'multi', OPS_MULTI, false),
  f('flagged', 'Flagged', 'option', OPS_EQUALITY, true),
  f('milestone', 'Milestone', 'multi', OPS_MULTI, false),
  f('id', 'Id', 'number', OPS_NUMBER, true),
  f('issuetype', 'Issue Type', 'option', OPS_OPTION, true),
  f('key', 'Key', 'key', OPS_NUMBER, true),
  f('labels', 'Labels', 'multi', OPS_MULTI, false),
  f('level', 'Level', 'option', OPS_OPTION, false),
  f('parent', 'Parent', 'number', OPS_EQUALITY, true),
  f('priority', 'Priority', 'option', OPS_OPTION, true),
  f('project', 'Project', 'option', OPS_OPTION, true),
  f('reporter', 'Reporter', 'user', OPS_OPTION, true),
  f('resolution', 'Resolution', 'option', OPS_OPTION, true),
  f('resolved', 'Resolved', 'date', OPS_DATE, true),
  f('status', 'Status', 'option', OPS_OPTION, true),
  f('summary', 'Summary', 'text', OPS_TEXT, true),
  f('text', 'Text', 'text', ['~', '!~'], false),
  f('updated', 'Updated', 'date', OPS_DATE, true),
];

export const JQL_FUNCTIONS: { value: string; displayName: string; isList: boolean; types: string[] }[] = [
  { value: 'currentUser()', displayName: 'currentUser()', isList: false, types: ['user'] },
  { value: 'membersOf()', displayName: 'membersOf()', isList: true, types: ['user'] },
  { value: 'now()', displayName: 'now()', isList: false, types: ['date'] },
  { value: 'startOfDay()', displayName: 'startOfDay()', isList: false, types: ['date'] },
  { value: 'endOfDay()', displayName: 'endOfDay()', isList: false, types: ['date'] },
  { value: 'startOfWeek()', displayName: 'startOfWeek()', isList: false, types: ['date'] },
  { value: 'endOfWeek()', displayName: 'endOfWeek()', isList: false, types: ['date'] },
  { value: 'startOfMonth()', displayName: 'startOfMonth()', isList: false, types: ['date'] },
  { value: 'endOfMonth()', displayName: 'endOfMonth()', isList: false, types: ['date'] },
  { value: 'openSprints()', displayName: 'openSprints()', isList: true, types: ['sprint'] },
  { value: 'closedSprints()', displayName: 'closedSprints()', isList: true, types: ['sprint'] },
  { value: 'linkedIssues()', displayName: 'linkedIssues()', isList: true, types: ['key'] },
  { value: 'blockedBy()', displayName: 'blockedBy()', isList: true, types: ['key'] },
  { value: 'blocking()', displayName: 'blocking()', isList: true, types: ['key'] },
  { value: 'subtasksOf()', displayName: 'subtasksOf()', isList: true, types: ['key'] },
  { value: 'issuesWithoutParent()', displayName: 'issuesWithoutParent()', isList: true, types: ['key'] },
];

const FIELD_BY_NAME = new Map(JQL_FIELDS.map((d) => [d.value, d]));
const FUNCTION_NAMES = new Set(JQL_FUNCTIONS.map((fn) => fn.value.replace('()', '').toLowerCase()));

export function getFieldDef(name: string): JqlFieldDef | undefined {
  return FIELD_BY_NAME.get(name.toLowerCase());
}

export function isKnownField(name: string): boolean {
  return FIELD_BY_NAME.has(name.toLowerCase()) || /^customfield_\d+$/i.test(name);
}

/* ------------------------------------------------------------------ */
/*  Context detection                                                  */
/* ------------------------------------------------------------------ */

export type CompletionKind = 'field' | 'operator' | 'value' | 'keyword' | 'orderField' | 'none';

export interface CompletionContext {
  kind: CompletionKind;
  /** Text already typed for the item being completed (without a leading quote). */
  prefix: string;
  /** Field the value/operator belongs to (lowercase), if known. */
  field?: string;
  /** True when inside `IN (...)`. */
  inList?: boolean;
  /** Candidate keywords for kind === 'keyword'. */
  keywords?: string[];
  /** Range of the input text replaced when a suggestion is applied. */
  replaceFrom: number;
  replaceTo: number;
  /** The partial item was opened with a double quote. */
  quoted?: boolean;
}

interface Tok {
  type: Token['type'];
  value: string;
  start: number;
  end: number;
}

const WORDLIKE = new Set<string>([
  'WORD', 'NUMBER', 'AND', 'OR', 'NOT', 'IN', 'IS', 'WAS', 'WERE', 'CHANGED', 'FROM', 'TO', 'DURING', 'BY',
  'ORDER', 'ASC', 'DESC', 'EMPTY', 'NULL',
]);

function withEnds(tokens: Token[], text: string): Tok[] {
  const out: Tok[] = [];
  for (const t of tokens) {
    if (t.type === 'EOF') continue;
    let end: number;
    if (t.type === 'STRING') end = t.pos + t.value.length + 2;
    else if (t.type === 'ORDER') end = t.pos + 5;
    else end = t.pos + t.value.length;
    out.push({ type: t.type, value: t.value, start: t.pos, end: Math.min(end, text.length) });
  }
  return out;
}

type State =
  | 'clause'
  | 'operator'
  | 'value'
  | 'isValue'
  | 'afterValue'
  | 'by'
  | 'orderField'
  | 'afterOrderField'
  | 'afterOrderDir';

interface Walk {
  state: State;
  field?: string;
  inList: boolean;
}

/** Walk complete tokens and work out what is grammatically expected next. */
function walk(tokens: Tok[]): Walk {
  let state: State = 'clause';
  let field: string | undefined;
  let inList = false;
  let depth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (state) {
      case 'clause':
        if (t.type === 'WORD') {
          field = t.value.toLowerCase();
          state = 'operator';
        } else if (t.type === 'LPAREN') depth++;
        else if (t.type === 'ORDER') state = 'by';
        break;
      case 'operator':
        if (t.type === 'OPERATOR' || t.type === 'IN') state = 'value';
        else if (t.type === 'IS') state = 'isValue';
        else if (t.type === 'NOT' || t.type === 'WAS' || (t.type as string) === 'WERE') {
          /* NOT IN / WAS IN: stay */
        } else if (t.type === 'CHANGED') state = 'afterValue';
        else state = 'clause';
        break;
      case 'isValue':
        if (t.type === 'NOT') break;
        state = 'afterValue';
        break;
      case 'value':
        if (t.type === 'LPAREN') {
          inList = true;
        } else if (t.type === 'WORD' && tokens[i + 1]?.type === 'LPAREN') {
          // function call: skip to the matching RPAREN
          let d = 0;
          i++;
          for (; i < tokens.length; i++) {
            if (tokens[i].type === 'LPAREN') d++;
            else if (tokens[i].type === 'RPAREN' && --d === 0) break;
          }
          state = 'afterValue';
          if (inList) state = 'afterValue';
        } else if (t.type === 'COMMA') {
          /* stay */
        } else if (t.type === 'RPAREN') {
          inList = false;
          state = 'afterValue';
        } else {
          // scalar value; inside a list stay in "afterValue" until comma/rparen
          state = 'afterValue';
        }
        break;
      case 'afterValue':
        if (t.type === 'AND' || t.type === 'OR') {
          state = 'clause';
          field = undefined;
          inList = false;
        } else if (t.type === 'COMMA' && inList) state = 'value';
        else if (t.type === 'RPAREN') {
          if (inList) inList = false;
          else if (depth > 0) depth--;
        } else if (t.type === 'ORDER') state = 'by';
        break;
      case 'by':
        if (t.type === 'BY') state = 'orderField';
        break;
      case 'orderField':
        if (t.type === 'WORD') state = 'afterOrderField';
        break;
      case 'afterOrderField':
        if (t.type === 'ASC' || t.type === 'DESC') state = 'afterOrderDir';
        else if (t.type === 'COMMA') state = 'orderField';
        break;
      case 'afterOrderDir':
        if (t.type === 'COMMA') state = 'orderField';
        break;
    }
  }
  return { state, field, inList };
}

function isIdentChar(ch: string | undefined): boolean {
  return !!ch && /[a-zA-Z0-9_-]/.test(ch);
}

/**
 * Decide what the user is completing at `cursor` in `text`. Only the text before the cursor is
 * analysed; trailing identifier characters after the cursor are included in the replaced range.
 */
export function detectContext(text: string, cursorPos: number = text.length): CompletionContext {
  const cursor = Math.max(0, Math.min(cursorPos, text.length));
  const before = text.slice(0, cursor);

  // Open double-quoted string at the cursor (odd number of quotes before it).
  const quoteCount = (before.match(/"/g) || []).length;
  if (quoteCount % 2 === 1) {
    const q = before.lastIndexOf('"');
    const head = tokenizeSafe(before.slice(0, q), text);
    const w = walk(head);
    if (w.state === 'value') {
      return {
        kind: 'value', prefix: before.slice(q + 1), field: w.field, inList: w.inList,
        replaceFrom: q, replaceTo: extendOverQuote(text, cursor), quoted: true,
      };
    }
    return { kind: 'none', prefix: '', replaceFrom: cursor, replaceTo: cursor };
  }

  const all = tokenizeSafe(before, text);
  let partial: Tok | undefined;
  const last = all[all.length - 1];
  if (last && last.end === cursor && cursor > 0 && !/\s/.test(before[cursor - 1])) {
    const partialOperator = last.type === 'OPERATOR' && last.value === '!';
    if (WORDLIKE.has(last.type) || partialOperator) partial = last;
  }
  const complete = partial ? all.slice(0, -1) : all;
  const w = walk(complete);

  let replaceFrom = partial ? partial.start : cursor;
  let replaceTo = cursor;
  if (partial) while (isIdentChar(text[replaceTo])) replaceTo++;
  const prefix = partial ? partial.value : '';
  const base = { prefix, replaceFrom, replaceTo };

  switch (w.state) {
    case 'clause':
      return { kind: 'field', ...base, keywords: ['NOT', 'ORDER BY'] };
    case 'operator':
      return { kind: 'operator', field: w.field, ...base };
    case 'value':
      return { kind: 'value', field: w.field, inList: w.inList, ...base };
    case 'isValue':
      return { kind: 'keyword', keywords: ['EMPTY', 'NULL', 'NOT'], ...base };
    case 'afterValue':
      return { kind: 'keyword', keywords: w.inList ? [] : ['AND', 'OR', 'ORDER BY'], field: w.field, ...base };
    case 'by':
      return { kind: 'keyword', keywords: ['BY'], ...base };
    case 'orderField':
      return { kind: 'orderField', ...base };
    case 'afterOrderField':
      return { kind: 'keyword', keywords: ['ASC', 'DESC'], ...base };
    default:
      return { kind: 'none', prefix: '', replaceFrom: cursor, replaceTo: cursor };
  }
}

function extendOverQuote(text: string, cursor: number): number {
  // If a closing quote directly follows the cursor region, replace it too.
  const next = text.indexOf('"', cursor);
  if (next === -1) return cursor;
  return /^[^\s",()]*$/.test(text.slice(cursor, next)) ? next + 1 : cursor;
}

function tokenizeSafe(src: string, _full: string): Tok[] {
  try {
    return withEnds(tokenize(src), src);
  } catch {
    // Lex as much as possible: drop trailing characters until it tokenizes.
    for (let n = src.length - 1; n > 0; n--) {
      try {
        return withEnds(tokenize(src.slice(0, n)), src);
      } catch {
        /* keep trimming */
      }
    }
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Static suggestions (fields, operators, keywords, functions)        */
/* ------------------------------------------------------------------ */

export interface Suggestion {
  value: string;
  displayName: string;
  /** Text inserted into the query (already quoted/spaced as needed). */
  insertText: string;
  type: 'field' | 'operator' | 'keyword' | 'value' | 'function';
}

export const MAX_SUGGESTIONS = 20;

const startsWithCI = (s: string, p: string) => s.toLowerCase().startsWith(p.toLowerCase());

/** Quote a JQL value when needed. */
export function quoteValue(v: string): string {
  return /^[A-Za-z0-9_]+$/.test(v) && !/^(and|or|not|in|is|empty|null|order|by|asc|desc|was|changed)$/i.test(v)
    ? v
    : `"${v.replace(/"/g, '')}"`;
}

export function staticSuggestions(ctx: CompletionContext): Suggestion[] {
  const p = ctx.prefix;
  const out: Suggestion[] = [];
  switch (ctx.kind) {
    case 'field':
      for (const d of JQL_FIELDS) {
        if (startsWithCI(d.value, p) || startsWithCI(d.displayName, p)) {
          out.push({ value: d.value, displayName: d.displayName, insertText: d.value, type: 'field' });
        }
      }
      for (const k of ctx.keywords ?? []) {
        if (p && startsWithCI(k, p)) out.push({ value: k, displayName: k, insertText: k, type: 'keyword' });
      }
      break;
    case 'orderField':
      for (const d of JQL_FIELDS) {
        if (d.orderable && (startsWithCI(d.value, p) || startsWithCI(d.displayName, p))) {
          out.push({ value: d.value, displayName: d.displayName, insertText: d.value, type: 'field' });
        }
      }
      break;
    case 'operator': {
      const def = ctx.field ? getFieldDef(ctx.field) : undefined;
      const ops = def?.operators ?? ['=', '!=', '~', 'IN', 'IS'];
      for (const o of ops) {
        if (!p || startsWithCI(o, p)) out.push({ value: o, displayName: o, insertText: o, type: 'operator' });
      }
      break;
    }
    case 'keyword':
      for (const k of ctx.keywords ?? []) {
        if (!p || startsWithCI(k, p)) out.push({ value: k, displayName: k, insertText: k, type: 'keyword' });
      }
      break;
    case 'value': {
      const def = ctx.field ? getFieldDef(ctx.field) : undefined;
      if (!ctx.quoted) {
        for (const fn of JQL_FUNCTIONS) {
          if (def && !fn.types.includes(def.kind)) continue;
          if (!p || startsWithCI(fn.value, p)) {
            out.push({ value: fn.value, displayName: fn.displayName, insertText: fn.value, type: 'function' });
          }
        }
      }
      break;
    }
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

/** Build the final suggestion for a DB value (quoting as needed). */
export function valueSuggestion(value: string, displayName: string, ctx: CompletionContext): Suggestion {
  return { value, displayName, insertText: quoteValue(value), type: 'value' };
}

/** Does inserting at replaceFrom need a separating space? */
export function needsLeadingSpace(text: string, ctx: CompletionContext): boolean {
  if (ctx.replaceFrom === 0) return false;
  const prev = text[ctx.replaceFrom - 1];
  return !!prev && !/[\s(,]/.test(prev);
}

/* ------------------------------------------------------------------ */
/*  Validation with positions                                          */
/* ------------------------------------------------------------------ */

export interface JqlValidationError {
  message: string;
  pos: number;
  length: number;
}

export interface JqlValidationResult {
  valid: boolean;
  errors: JqlValidationError[];
}

function collectValues(v: JQLValue, out: JQLValue[]) {
  out.push(v);
  if (v.type === 'list') v.values.forEach((x) => collectValues(x, out));
  if (v.type === 'function') v.args.forEach((x) => collectValues(x, out));
}

function walkNode(node: JQLNode | null, fields: Set<string>, values: JQLValue[]) {
  if (!node) return;
  switch (node.type) {
    case 'query':
      walkNode(node.where, fields, values);
      node.orderBy.forEach((o) => fields.add(o.field));
      break;
    case 'and':
    case 'or':
      node.clauses.forEach((c) => walkNode(c, fields, values));
      break;
    case 'not':
      walkNode(node.clause, fields, values);
      break;
    case 'condition':
      fields.add(node.field);
      collectValues(node.value, values);
      break;
    case 'changed':
      fields.add(node.field);
      if (node.from) collectValues(node.from, values);
      if (node.to) collectValues(node.to, values);
      if (node.during) node.during.forEach((v) => collectValues(v, values));
      break;
  }
}

export const MAX_JQL_LENGTH = 5000;

/** Parse and semantically check a JQL string. Never throws. */
export function validateJql(jql: string): JqlValidationResult {
  if (jql.length > MAX_JQL_LENGTH) {
    return { valid: false, errors: [{ message: `Query too long (max ${MAX_JQL_LENGTH} characters)`, pos: 0, length: 0 }] };
  }
  let tokens: Token[];
  try {
    tokens = tokenize(jql);
  } catch (e) {
    return { valid: false, errors: [toError(e, jql)] };
  }
  let ast: JQLNode;
  try {
    ast = parseJQLTokens(tokens);
  } catch (e) {
    return { valid: false, errors: [toError(e, jql)] };
  }

  const errors: JqlValidationError[] = [];
  const fields = new Set<string>();
  const values: JQLValue[] = [];
  walkNode(ast, fields, values);

  for (const fld of fields) {
    if (!isKnownField(fld)) {
      const tok = tokens.find((t) => t.type === 'WORD' && t.value === fld);
      errors.push({ message: `Field '${fld}' does not exist or you do not have permission to view it.`, pos: tok?.pos ?? 0, length: fld.length });
    }
  }
  for (const v of values) {
    if (v.type === 'function' && !FUNCTION_NAMES.has(v.name.toLowerCase())) {
      const tok = tokens.find((t) => t.type === 'WORD' && t.value === v.name);
      errors.push({ message: `Function '${v.name}' does not exist.`, pos: tok?.pos ?? 0, length: v.name.length });
    }
  }
  errors.sort((a, b) => a.pos - b.pos);
  return { valid: errors.length === 0, errors };
}

function toError(e: unknown, jql: string): JqlValidationError {
  if (e instanceof JQLError) {
    const pos = Math.min(e.pos ?? 0, jql.length);
    // Strip the redundant "at pos N" suffix the parser appends.
    return { message: e.message.replace(/ at pos \d+$/, ''), pos, length: Math.max(0, Math.min(1, jql.length - pos)) };
  }
  return { message: 'Invalid JQL query', pos: 0, length: 0 };
}
