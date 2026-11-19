/**
 * SCIM filter (RFC 7644 section 3.4.2.2) parser: a pragmatic subset.
 * Supported: eq ne co sw ew gt ge lt le pr, and / or / not, parentheses.
 * Not supported: value-path filters inside attribute paths (`emails[type eq "work"]`).
 */
import { ScimError } from './errors';

export type FilterNode =
  | { type: 'cmp'; attr: string; op: 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'ge' | 'lt' | 'le'; value: string | number | boolean | null }
  | { type: 'pr'; attr: string }
  | { type: 'and' | 'or'; left: FilterNode; right: FilterNode }
  | { type: 'not'; expr: FilterNode };

type Tok = { k: 'lp' | 'rp' | 'str' | 'word'; v: string };

const MAX_FILTER_LENGTH = 1000;
const MAX_DEPTH = 20;

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '(') { out.push({ k: 'lp', v: ch }); i++; continue; }
    if (ch === ')') { out.push({ k: 'rp', v: ch }); i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const n = input[j + 1];
          if (n === undefined) throw ScimError.invalidFilter('Unterminated string');
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else {
          s += input[j++];
        }
      }
      if (j >= input.length) throw ScimError.invalidFilter('Unterminated string');
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < input.length && !' \t()"'.includes(input[j])) j++;
    out.push({ k: 'word', v: input.slice(i, j) });
    i = j;
  }
  return out;
}

export function parseFilter(input: string): FilterNode {
  if (input.length > MAX_FILTER_LENGTH) throw ScimError.invalidFilter('Filter too long');
  const toks = tokenize(input);
  let pos = 0;
  const peek = () => toks[pos];
  const isWord = (t: Tok | undefined, w: string) => t?.k === 'word' && t.v.toLowerCase() === w;

  const parseOr = (depth: number): FilterNode => {
    if (depth > MAX_DEPTH) throw ScimError.invalidFilter('Filter too deeply nested');
    let left = parseAnd(depth);
    while (isWord(peek(), 'or')) { pos++; left = { type: 'or', left, right: parseAnd(depth) }; }
    return left;
  };
  const parseAnd = (depth: number): FilterNode => {
    let left = parseFactor(depth);
    while (isWord(peek(), 'and')) { pos++; left = { type: 'and', left, right: parseFactor(depth) }; }
    return left;
  };
  const parseFactor = (depth: number): FilterNode => {
    const t = peek();
    if (!t) throw ScimError.invalidFilter('Unexpected end of filter');
    if (t.k === 'lp') {
      pos++;
      const e = parseOr(depth + 1);
      if (peek()?.k !== 'rp') throw ScimError.invalidFilter('Missing closing parenthesis');
      pos++;
      return e;
    }
    if (isWord(t, 'not')) {
      pos++;
      if (peek()?.k !== 'lp') throw ScimError.invalidFilter('"not" must be followed by "("');
      pos++;
      const e = parseOr(depth + 1);
      if (peek()?.k !== 'rp') throw ScimError.invalidFilter('Missing closing parenthesis');
      pos++;
      return { type: 'not', expr: e };
    }
    if (t.k !== 'word') throw ScimError.invalidFilter('Attribute name expected');
    if (t.v.includes('[') || t.v.includes(']')) throw ScimError.invalidFilter('Value-path filters are not supported');
    pos++;
    const attr = t.v;
    const opTok = peek();
    if (!opTok || opTok.k !== 'word') throw ScimError.invalidFilter('Operator expected');
    const op = opTok.v.toLowerCase();
    pos++;
    if (op === 'pr') return { type: 'pr', attr };
    if (!['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'ge', 'lt', 'le'].includes(op)) throw ScimError.invalidFilter(`Unknown operator "${opTok.v}"`);
    const v = peek();
    if (!v) throw ScimError.invalidFilter('Comparison value expected');
    pos++;
    let value: string | number | boolean | null;
    if (v.k === 'str') value = v.v;
    else if (v.k === 'word') {
      const w = v.v.toLowerCase();
      if (w === 'true') value = true;
      else if (w === 'false') value = false;
      else if (w === 'null') value = null;
      else if (/^-?\d+(\.\d+)?$/.test(v.v)) value = Number(v.v);
      else throw ScimError.invalidFilter('Invalid comparison value');
    } else throw ScimError.invalidFilter('Comparison value expected');
    return { type: 'cmp', attr, op: op as any, value };
  };

  const ast = parseOr(0);
  if (pos < toks.length) throw ScimError.invalidFilter('Unexpected trailing input');
  return ast;
}
