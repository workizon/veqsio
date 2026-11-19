/**
 * Safe string templating for inbound webhook mappings.
 *
 * A template is plain text with `{{ path }}` placeholders. A path is a dotted / indexed lookup into the JSON payload
 * (`alerts[0].labels.alertname`, `$.data.event.title`). After the path, filters can follow, separated by `|`:
 * `default "text"`, `upper`, `lower`, `trim`, `truncate 80`, `first` (first line), `json`.
 *
 * Nothing here evaluates code: the expression grammar is a fixed lookup + a whitelist of filters, prototype keys are
 * never read, and template length, nesting depth, value size and output size are capped so a hostile payload or
 * template cannot make the server do unbounded work.
 */

export const MAX_TEMPLATE_LENGTH = 4000;
export const MAX_OUTPUT_LENGTH = 20_000;
const MAX_VALUE_LENGTH = 4000;
const MAX_PATH_SEGMENTS = 20;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type PathSegment = string | number;

/** Parses `a.b[0].c`, `$.a`, `a["b c"]` into segments. Returns null for anything outside the grammar. */
export function parsePath(raw: string): PathSegment[] | null {
  let p = raw.trim();
  if (p === '$' || p === '') return p === '$' ? [] : null;
  if (p.startsWith('$.')) p = p.slice(2);
  else if (p.startsWith('$[')) p = p.slice(1);
  const out: PathSegment[] = [];
  let i = 0;
  while (i < p.length) {
    if (out.length >= MAX_PATH_SEGMENTS) return null;
    const ch = p[i];
    if (ch === '[') {
      const close = p.indexOf(']', i);
      if (close < 0) return null;
      const inner = p.slice(i + 1, close).trim();
      if (/^\d{1,6}$/.test(inner)) out.push(Number(inner));
      else {
        const m = /^"([^"\\]{1,100})"$/.exec(inner) ?? /^'([^'\\]{1,100})'$/.exec(inner);
        if (!m) return null;
        out.push(m[1]);
      }
      i = close + 1;
      if (p[i] === '.') i++;
      continue;
    }
    const m = /^[A-Za-z0-9_@-][A-Za-z0-9_@ -]{0,99}/.exec(p.slice(i));
    if (!m) return null;
    // A key may contain inner spaces only when it is followed by a separator; trailing spaces are not part of it.
    const key = m[0].replace(/\s+$/, '');
    out.push(key);
    i += key.length;
    if (p[i] === '.') { i++; if (i >= p.length) return null; }
    else if (i < p.length && p[i] !== '[') return null;
  }
  return out;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Reads a value without ever touching the prototype chain. Undefined when the path does not exist. */
export function getPath(data: unknown, path: string | PathSegment[]): unknown {
  const segs = typeof path === 'string' ? parsePath(path) : path;
  if (!segs) return undefined;
  let cur: unknown = data;
  for (const s of segs) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof s === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[s];
    } else {
      if (FORBIDDEN_KEYS.has(s) || typeof cur !== 'object' || Array.isArray(cur) || !hasOwn(cur as object, s)) return undefined;
      cur = (cur as Record<string, unknown>)[s];
    }
  }
  return cur;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export const stripControl = (s: string) => s.replace(CONTROL, '');

/** Text form of a payload value; objects are shown as compact JSON, arrays of scalars as a comma list. */
export function stringifyValue(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = '';
  else if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') s = String(v);
  else if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) s = v.map((x) => String(x ?? '')).join(', ');
  else { try { s = JSON.stringify(v) ?? ''; } catch { s = ''; } }
  s = stripControl(s);
  return s.length > MAX_VALUE_LENGTH ? s.slice(0, MAX_VALUE_LENGTH) + '...' : s;
}

interface Filter { name: string; arg?: string }
const FILTERS = new Set(['default', 'upper', 'lower', 'trim', 'truncate', 'first', 'json']);

function parseExpression(expr: string): { path: PathSegment[]; filters: Filter[] } | null {
  // Split on pipes that are outside double quotes.
  const parts: string[] = [];
  let cur = '', quoted = false;
  for (const ch of expr) {
    if (ch === '"') quoted = !quoted;
    if (ch === '|' && !quoted) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  const path = parsePath(parts[0]);
  if (!path) return null;
  const filters: Filter[] = [];
  for (const raw of parts.slice(1)) {
    const m = /^\s*([a-z]+)(?:\s+(.*?))?\s*$/.exec(raw);
    if (!m || !FILTERS.has(m[1])) return null;
    let arg = m[2];
    if (arg !== undefined && /^".*"$/s.test(arg)) arg = arg.slice(1, -1);
    filters.push({ name: m[1], arg });
  }
  return { path, filters };
}

function applyFilter(value: string, raw: unknown, f: Filter): string {
  switch (f.name) {
    case 'default': return value === '' ? (f.arg ?? '') : value;
    case 'upper': return value.toUpperCase();
    case 'lower': return value.toLowerCase();
    case 'trim': return value.trim();
    case 'first': return value.split(/\r?\n/, 1)[0];
    case 'json': { try { return stringifyValue(JSON.stringify(raw ?? null)); } catch { return ''; } }
    case 'truncate': {
      const n = Math.min(MAX_VALUE_LENGTH, Math.max(1, Number(f.arg) || 100));
      return value.length > n ? value.slice(0, Math.max(0, n - 3)) + '...' : value;
    }
    default: return value;
  }
}

export interface RenderOptions { maxLength?: number }

/** Renders a template; unknown placeholders and invalid expressions render as an empty string. */
export function renderTemplate(template: string, data: unknown, opts: RenderOptions = {}): string {
  const max = opts.maxLength ?? MAX_OUTPUT_LENGTH;
  const tpl = template.length > MAX_TEMPLATE_LENGTH ? template.slice(0, MAX_TEMPLATE_LENGTH) : template;
  let out = '';
  let last = 0;
  const re = /\{\{([^{}]*)\}\}/g;
  for (let m = re.exec(tpl); m; m = re.exec(tpl)) {
    out += tpl.slice(last, m.index);
    last = m.index + m[0].length;
    const ex = parseExpression(m[1]);
    if (ex) {
      const raw = getPath(data, ex.path);
      let s = stringifyValue(raw);
      for (const f of ex.filters) s = applyFilter(s, raw, f);
      out += s;
    }
    if (out.length > max) return out.slice(0, max);
  }
  out += tpl.slice(last);
  return out.length > max ? out.slice(0, max) : out;
}

/** Validation for saving a mapping: reports the first problem in a template, or null when it is fine. */
export function templateError(template: string): string | null {
  if (template.length > MAX_TEMPLATE_LENGTH) return `Template is longer than ${MAX_TEMPLATE_LENGTH} characters`;
  const re = /\{\{([^{}]*)\}\}/g;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (!parseExpression(m[1])) return `Invalid placeholder: {{${m[1].trim().slice(0, 60)}}}`;
  }
  const stripped = template.replace(re, '');
  if (stripped.includes('{{') || stripped.includes('}}')) return 'Unbalanced {{ }} in template';
  return null;
}
