import { describe, test, expect } from 'bun:test';
import { wrapSelection, prefixLines, insertLink, insertBlock, mentionAt, continueList } from '../lib/markdown-edit';

describe('markdown-edit', () => {
  test('wrap and unwrap', () => {
    const w = wrapSelection({ value: 'a word b', start: 2, end: 6 }, '**');
    expect(w.value).toBe('a **word** b');
    const u = wrapSelection({ value: w.value, start: 2, end: 10 }, '**');
    expect(u.value).toBe('a word b');
  });
  test('prefix lines toggles', () => {
    const a = prefixLines({ value: 'x\ny', start: 0, end: 3 }, 'bullet');
    expect(a.value).toBe('- x\n- y');
    expect(prefixLines({ value: a.value, start: 0, end: a.value.length }, 'bullet').value).toBe('x\ny');
    expect(prefixLines({ value: 'x\ny', start: 0, end: 3 }, 'number').value).toBe('1. x\n2. y');
    expect(prefixLines({ value: 'x', start: 0, end: 1 }, 'task').value).toBe('- [ ] x');
  });
  test('link selects url placeholder', () => {
    const r = insertLink({ value: 'see docs', start: 4, end: 8 });
    expect(r.value).toBe('see [docs](url)');
    expect(r.value.slice(r.start, r.end)).toBe('url');
  });
  test('insertBlock adds blank lines around', () => {
    expect(insertBlock({ value: 'ab', start: 1, end: 1 }, '| t |').value).toBe('a\n\n| t |\n\nb');
    expect(insertBlock({ value: '', start: 0, end: 0 }, '| t |').value).toBe('| t |\n');
  });
  test('mention detection', () => {
    expect(mentionAt('hi @al', 6)).toEqual({ query: 'al', from: 3 });
    expect(mentionAt('mail a@b', 8)).toBeNull();
  });
  test('list continuation', () => {
    expect(continueList({ value: '- a', start: 3, end: 3 })?.value).toBe('- a\n- ');
    expect(continueList({ value: '1. a', start: 4, end: 4 })?.value).toBe('1. a\n2. ');
    expect(continueList({ value: '- a\n- ', start: 6, end: 6 })?.value).toBe('- a\n');
    expect(continueList({ value: 'plain', start: 5, end: 5 })).toBeNull();
  });
});
