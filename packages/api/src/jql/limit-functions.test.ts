import { describe, it, expect } from 'bun:test';
import { parseJQL, parseJQLSafe } from './index';

describe('JQL LIMIT', () => {
  it('parses LIMIT after ORDER BY', () => {
    const r = parseJQL('project = TEST ORDER BY created DESC LIMIT 25');
    expect(r.limit).toBe(25);
    expect(r.orderBy).toHaveLength(1);
  });

  it('parses LIMIT after the conditions and on its own', () => {
    expect(parseJQL('project = TEST limit 3').limit).toBe(3);
    expect(parseJQL('LIMIT 7').limit).toBe(7);
    expect(parseJQL('project = TEST').limit).toBeUndefined();
  });

  it('rejects LIMIT 0, above 1000, fractions and garbage', () => {
    expect(parseJQLSafe('project = TEST LIMIT 0').success).toBe(false);
    expect(parseJQLSafe('project = TEST LIMIT 1001').success).toBe(false);
    expect(parseJQLSafe('project = TEST LIMIT 1000').success).toBe(true);
    expect(parseJQLSafe('project = TEST LIMIT abc').success).toBe(false);
    expect(parseJQLSafe('project = TEST ORDER BY created LIMIT 5 6').success).toBe(false);
  });

  it('does not treat the word inside a quoted value as LIMIT', () => {
    const r = parseJQLSafe('summary ~ "limit 5"');
    expect(r.success).toBe(true);
    if (r.success) expect(r.result.limit).toBeUndefined();
  });
});

describe('JQL issue-set functions', () => {
  it('accepts the relation helpers on key / id', () => {
    for (const q of [
      'key in linkedIssues("TEST-1")',
      'key in linkedIssues("TEST-1", "blocks")',
      'key in linkedIssues(TEST-1, "is blocked by")',
      'key not in blockedBy("TEST-1")',
      'id in blocking("TEST-1")',
      'key in subtasksOf("TEST-1")',
      'key in issuesWithoutParent()',
      'key = blocking("TEST-1") ORDER BY created LIMIT 10',
    ]) {
      const r = parseJQLSafe(q);
      if (!r.success) throw new Error(`${q}: ${r.error}`);
      expect(r.success).toBe(true);
    }
  });

  it('rejects helpers on other fields, without a key and with bad operators', () => {
    expect(parseJQLSafe('status in linkedIssues("TEST-1")').success).toBe(false);
    expect(parseJQLSafe('key in linkedIssues()').success).toBe(false);
    expect(parseJQLSafe('key in linkedIssues("nonsense")').success).toBe(false);
    expect(parseJQLSafe('key > blocking("TEST-1")').success).toBe(false);
  });

  it('IN accepts a list-returning function for other fields too', () => {
    expect(parseJQLSafe('assignee in membersOf("devs")', { groupMembers: { devs: [1, 2] } }).success).toBe(true);
  });
});
