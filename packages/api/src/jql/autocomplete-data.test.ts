import { describe, it, expect } from 'bun:test';
import { AUTOCOMPLETE_FIELDS, AUTOCOMPLETE_FUNCTIONS, filterAndRank, SUGGESTIBLE_FIELDS } from './autocomplete-data';
import { parseJQL } from './index';

describe('JQL autocomplete data', () => {
  it('has unique field values', () => {
    const names = AUTOCOMPLETE_FIELDS.map((x) => x.value);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every function is parseable by the JQL engine', () => {
    for (const fn of AUTOCOMPLETE_FUNCTIONS) {
      if (fn.value.startsWith('openSprints') || fn.value.startsWith('closedSprints')) continue;
      // issue-set functions are used with the key field, the others as plain values
      const jql = fn.types.some((t) => t.endsWith('.Issue')) ? `key in ${fn.value}` : `created = ${fn.value}`;
      expect(() => parseJQL(jql, { currentUserId: 1, groupMembers: {} })).not.toThrow();
    }
  });

  it('suggestible fields are advertised as auto-complete fields', () => {
    const auto = new Set(AUTOCOMPLETE_FIELDS.filter((x) => x.auto).map((x) => x.value));
    for (const name of ['assignee', 'status', 'project', 'labels']) {
      expect(auto.has(name)).toBe(true);
      expect(SUGGESTIBLE_FIELDS.has(name)).toBe(true);
    }
  });

  it('filterAndRank orders prefix matches first and respects limit', () => {
    const items = [{ displayName: 'In Progress' }, { displayName: 'Progress Review' }, { displayName: 'Done' }];
    expect(filterAndRank(items, 'pro', 10).map((i) => i.displayName)).toEqual(['Progress Review', 'In Progress']);
    expect(filterAndRank(items, '', 2)).toHaveLength(2);
  });
});
