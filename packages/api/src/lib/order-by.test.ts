import { describe, expect, it } from 'bun:test';
import { parseOrderBy } from './order-by';

describe('parseOrderBy', () => {
  const allowed = ['name', 'email', 'created'];
  it('parses columns and directions in order', () => {
    expect(parseOrderBy('name:asc,email:desc', allowed)).toEqual([{ col: 'name', dir: 'asc' }, { col: 'email', dir: 'desc' }]);
  });
  it('defaults to asc and ignores case', () => {
    expect(parseOrderBy('email, created:DESC', allowed)).toEqual([{ col: 'email', dir: 'asc' }, { col: 'created', dir: 'desc' }]);
  });
  it('drops unknown columns, duplicates and junk (never reaches SQL)', () => {
    expect(parseOrderBy('password:asc,name:desc,name:asc,1;drop table users:asc,', allowed)).toEqual([{ col: 'name', dir: 'desc' }]);
  });
  it('is empty for nothing', () => {
    expect(parseOrderBy(undefined, allowed)).toEqual([]);
    expect(parseOrderBy('', allowed)).toEqual([]);
  });
});
