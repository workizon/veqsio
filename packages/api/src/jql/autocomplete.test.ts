import { describe, it, expect } from 'bun:test';
import { detectContext, staticSuggestions, validateJql, JQL_FIELDS, needsLeadingSpace, quoteValue } from './autocomplete';

const at = (t: string) => detectContext(t, t.length);

describe('detectContext', () => {
  it('empty input completes a field', () => {
    expect(at('').kind).toBe('field');
  });
  it('partial field name', () => {
    expect(at('sta')).toMatchObject({ kind: 'field', prefix: 'sta', replaceFrom: 0, replaceTo: 3 });
  });
  it('operator after field and space', () => {
    expect(at('status ')).toMatchObject({ kind: 'operator', field: 'status', prefix: '' });
  });
  it('partial operator "!"', () => {
    expect(at('status !')).toMatchObject({ kind: 'operator', prefix: '!' });
  });
  it('complete operator moves to value', () => {
    expect(at('status =')).toMatchObject({ kind: 'value', field: 'status', prefix: '' });
    expect(at('status = ')).toMatchObject({ kind: 'value', field: 'status', prefix: '' });
  });
  it('partial value', () => {
    expect(at('status = Op')).toMatchObject({ kind: 'value', field: 'status', prefix: 'Op', replaceFrom: 9 });
  });
  it('quoted partial value', () => {
    expect(at('status = "In Pro')).toMatchObject({ kind: 'value', field: 'status', prefix: 'In Pro', quoted: true, replaceFrom: 9 });
  });
  it('quote in a non-value position gives none', () => {
    expect(at('status "x').kind).toBe('none');
  });
  it('keyword after a complete value', () => {
    const c = at('status = Open ');
    expect(c.kind).toBe('keyword');
    expect(c.keywords).toEqual(['AND', 'OR', 'ORDER BY']);
  });
  it('partial keyword', () => {
    expect(at('status = Open AN')).toMatchObject({ kind: 'keyword', prefix: 'AN' });
    expect(at('status = "Open" o')).toMatchObject({ kind: 'keyword', prefix: 'o' });
  });
  it('field after AND / OR / NOT / paren', () => {
    expect(at('status = Open AND ').kind).toBe('field');
    expect(at('status = Open OR pri')).toMatchObject({ kind: 'field', prefix: 'pri' });
    expect(at('NOT ').kind).toBe('field');
    expect(at('(').kind).toBe('field');
    expect(at('(status = Open) AND ').kind).toBe('field');
  });
  it('IN list value positions', () => {
    expect(at('status IN (')).toMatchObject({ kind: 'value', field: 'status', inList: true });
    expect(at('status IN (Open, ')).toMatchObject({ kind: 'value', inList: true, field: 'status' });
    expect(at('status IN ("Open", Cl')).toMatchObject({ kind: 'value', prefix: 'Cl', inList: true });
    expect(at('status IN (Open ').keywords).toEqual([]);
    expect(at('status IN (Open) ').keywords).toEqual(['AND', 'OR', 'ORDER BY']);
  });
  it('NOT IN', () => {
    expect(at('status NOT ')).toMatchObject({ kind: 'operator' });
    expect(at('status NOT IN (')).toMatchObject({ kind: 'value', inList: true });
  });
  it('IS completes EMPTY/NULL', () => {
    const c = at('assignee IS ');
    expect(c.kind).toBe('keyword');
    expect(c.keywords).toContain('EMPTY');
    expect(at('assignee IS EMPTY ').keywords).toContain('AND');
  });
  it('function call counts as one value', () => {
    expect(at('assignee = currentUser() ').keywords).toContain('AND');
    expect(at('assignee = currentUser() AND ').kind).toBe('field');
    expect(at('assignee IN (currentUser(), ')).toMatchObject({ kind: 'value', inList: true });
  });
  it('ORDER BY flow', () => {
    expect(at('status = Open ORDER ')).toMatchObject({ kind: 'keyword', keywords: ['BY'] });
    expect(at('status = Open ORDER BY ').kind).toBe('orderField');
    expect(at('ORDER BY cre')).toMatchObject({ kind: 'orderField', prefix: 'cre' });
    expect(at('ORDER BY created ').keywords).toEqual(['ASC', 'DESC']);
    expect(at('ORDER BY created DESC, ').kind).toBe('orderField');
    expect(at('ORDER BY created DESC ').kind).toBe('none');
  });
  it('cursor in the middle only looks before the cursor and replaces the word', () => {
    expect(detectContext('status = Open AND priority = High', 14).kind).toBe('keyword');
    expect(detectContext('stxxx = Open', 2)).toMatchObject({ kind: 'field', prefix: 'st', replaceFrom: 0, replaceTo: 5 });
  });
  it('cursor is clamped', () => {
    expect(detectContext('st', 99).prefix).toBe('st');
    expect(detectContext('st', -4).kind).toBe('field');
  });
  it('never throws on garbage', () => {
    for (const t of ['"', '""', '(((', ')))', '= = =', '@#$', 'a"b"c"', 'status = "x" "']) {
      expect(() => at(t)).not.toThrow();
    }
  });
  it('quoted value with closing quote after cursor extends the range', () => {
    const t = 'status = "In Pro"';
    const c = detectContext(t, 15);
    expect(c.kind).toBe('value');
    expect(c.replaceTo).toBe(t.length);
  });
});

describe('staticSuggestions', () => {
  it('filters fields by prefix, case-insensitively, max 20', () => {
    expect(staticSuggestions(at('PRI')).map((x) => x.value)).toEqual(['priority']);
    expect(staticSuggestions(at('')).length).toBeLessThanOrEqual(20);
  });
  it('field offers NOT/ORDER BY keywords only when typing', () => {
    expect(staticSuggestions(at('ORD')).some((s) => s.value === 'ORDER BY')).toBe(true);
    expect(staticSuggestions(at('')).some((s) => s.type === 'keyword')).toBe(false);
  });
  it('operators follow field type', () => {
    expect(staticSuggestions(at('summary ')).map((s) => s.value)).toEqual(['~', '!~', 'IS', 'IS NOT']);
    expect(staticSuggestions(at('created ')).map((s) => s.value)).toContain('>=');
    expect(staticSuggestions(at('status I')).map((s) => s.value)).toEqual(['IN', 'IS', 'IS NOT']);
  });
  it('order by only offers orderable fields', () => {
    const vals = staticSuggestions(at('ORDER BY ')).map((s) => s.value);
    expect(vals).toContain('created');
    expect(vals).not.toContain('labels');
  });
  it('functions are offered by field kind', () => {
    expect(staticSuggestions(at('assignee = ')).map((s) => s.value)).toContain('currentUser()');
    expect(staticSuggestions(at('status = ')).map((s) => s.value)).not.toContain('currentUser()');
    expect(staticSuggestions(at('created > ')).map((s) => s.value)).toContain('startOfDay()');
    expect(staticSuggestions(at('assignee = "cur')).length).toBe(0);
  });
});

describe('helpers', () => {
  it('quoteValue', () => {
    expect(quoteValue('Open')).toBe('Open');
    expect(quoteValue('In Progress')).toBe('"In Progress"');
    expect(quoteValue('and')).toBe('"and"');
    expect(quoteValue('a"b')).toBe('"ab"');
  });
  it('needsLeadingSpace', () => {
    expect(needsLeadingSpace('status =', at('status ='))).toBe(true);
    expect(needsLeadingSpace('status = ', at('status = '))).toBe(false);
    expect(needsLeadingSpace('', at(''))).toBe(false);
  });
  it('field metadata is sane', () => {
    for (const d of JQL_FIELDS) {
      expect(d.operators.length).toBeGreaterThan(0);
      expect(d.value).toBe(d.value.toLowerCase());
    }
  });
});

describe('validateJql', () => {
  it('accepts valid queries', () => {
    expect(validateJql('').valid).toBe(true);
    expect(validateJql('status = Open AND assignee = currentUser() ORDER BY created DESC').valid).toBe(true);
    expect(validateJql('customfield_10 = 3').valid).toBe(true);
  });
  it('reports parse errors with position', () => {
    const r = validateJql('status = ');
    expect(r.valid).toBe(false);
    expect(r.errors[0].pos).toBe(9);
    const r2 = validateJql('status = Open AND AND');
    expect(r2.errors[0].pos).toBeGreaterThanOrEqual(17);
    expect(r2.errors[0].message).not.toMatch(/at pos/);
  });
  it('reports lexer errors', () => {
    expect(validateJql('summary ~ "abc').errors[0].pos).toBe(10);
    expect(validateJql('status = @').errors[0].pos).toBe(9);
  });
  it('flags unknown fields and functions with positions', () => {
    const r = validateJql('status = Open AND foo = 1');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatchObject({ pos: 18, length: 3 });
    const f = validateJql('assignee = nobody()');
    expect(f.errors[0].message).toContain('nobody');
    expect(f.errors[0].pos).toBe(11);
  });
  it('bounds input size', () => {
    expect(validateJql('a'.repeat(6000)).valid).toBe(false);
  });
});
