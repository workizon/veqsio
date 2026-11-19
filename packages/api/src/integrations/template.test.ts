import { describe, test, expect } from 'bun:test';
import { getPath, parsePath, renderTemplate, templateError, stringifyValue } from './template';

const data = {
  title: 'Disk full',
  status: 'firing',
  alerts: [{ labels: { alertname: 'DiskFull', severity: 'critical' }, fingerprint: 'abc123' }],
  nested: { 'weird key': 'v', list: [1, 2, 3] },
  empty: '',
  n: 42,
  nul: null,
};

describe('template paths', () => {
  test('parses dotted, indexed and quoted paths', () => {
    expect(parsePath('a.b[0].c')).toEqual(['a', 'b', 0, 'c']);
    expect(parsePath('$.a')).toEqual(['a']);
    expect(parsePath('a["b c"]')).toEqual(['a', 'b c']);
    expect(parsePath('a..b')).toBeNull();
    expect(parsePath('a.')).toBeNull();
    expect(parsePath('a[x]')).toBeNull();
    expect(parsePath('a(b)')).toBeNull();
    expect(parsePath('')).toBeNull();
  });
  test('reads values and returns undefined for misses', () => {
    expect(getPath(data, 'alerts[0].labels.alertname')).toBe('DiskFull');
    expect(getPath(data, 'alerts[1].labels')).toBeUndefined();
    expect(getPath(data, 'title.length')).toBeUndefined();
    expect(getPath(data, 'nested["weird key"]')).toBe('v');
    expect(getPath(data, 'nul.x')).toBeUndefined();
  });
  test('never reads the prototype chain', () => {
    expect(getPath(data, '__proto__')).toBeUndefined();
    expect(getPath(data, 'constructor')).toBeUndefined();
    expect(getPath(data, 'constructor.prototype')).toBeUndefined();
    expect(getPath(data, 'toString')).toBeUndefined();
    expect(getPath(JSON.parse('{"__proto__":{"x":1}}'), '__proto__.x')).toBeUndefined();
    expect(renderTemplate('{{constructor.name}}|{{__proto__}}', data)).toBe('|');
  });
});

describe('renderTemplate', () => {
  test('substitutes placeholders', () => {
    expect(renderTemplate('[{{alerts[0].labels.severity}}] {{title}} #{{n}}', data)).toBe('[critical] Disk full #42');
  });
  test('missing values and invalid expressions render empty', () => {
    expect(renderTemplate('a{{nope}}b{{ 1+1 }}c{{process.env.HOME}}', data)).toBe('abc');
  });
  test('filters', () => {
    expect(renderTemplate('{{empty | default "n/a"}}', data)).toBe('n/a');
    expect(renderTemplate('{{title | upper}} {{title | lower}}', data)).toBe('DISK FULL disk full');
    expect(renderTemplate('{{title | truncate 6}}', data)).toBe('Dis...');
    expect(renderTemplate('{{multi | first}}', { multi: 'one\ntwo' })).toBe('one');
    expect(renderTemplate('{{missing | default "a|b"}}', data)).toBe('a|b');
  });
  test('unknown filters invalidate the placeholder', () => {
    expect(renderTemplate('{{title | eval}}', data)).toBe('');
    expect(templateError('{{title | eval}}')).toContain('Invalid placeholder');
  });
  test('objects are shown as JSON, scalar arrays as a list, control characters are removed', () => {
    expect(renderTemplate('{{nested.list}}', data)).toBe('1, 2, 3');
    expect(renderTemplate('{{alerts[0].labels}}', data)).toBe('{"alertname":"DiskFull","severity":"critical"}');
    expect(stringifyValue('a\u0000b\u0007c')).toBe('abc');
  });
  test('cannot execute code: expressions are lookups only', () => {
    const evil = { x: '{{title}}', y: '${1+1}' };
    expect(renderTemplate('{{x}}', evil)).toBe('{{title}}'); // values are never re-rendered
    expect(renderTemplate('{{y}}', evil)).toBe('${1+1}');
    expect(renderTemplate('{{ (() => 1)() }}', data)).toBe('');
    expect(renderTemplate('{{ this.constructor.constructor("return 1")() }}', data)).toBe('');
  });
  test('output and value sizes are capped', () => {
    const big = { v: 'x'.repeat(100_000) };
    expect(renderTemplate('{{v}}', big).length).toBeLessThan(4100);
    expect(renderTemplate('{{v}}{{v}}{{v}}{{v}}{{v}}{{v}}', big, { maxLength: 5000 }).length).toBeLessThanOrEqual(5000);
    expect(renderTemplate('y'.repeat(10_000), {}).length).toBeLessThanOrEqual(4000);
  });
});

describe('templateError', () => {
  test('accepts valid and rejects broken templates', () => {
    expect(templateError('Hello {{title}}')).toBeNull();
    expect(templateError('{{title')).toContain('Unbalanced');
    expect(templateError('{{a..b}}')).toContain('Invalid');
    expect(templateError('x'.repeat(5000))).toContain('longer');
  });
});
