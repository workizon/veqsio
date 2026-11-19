import { describe, it, expect } from 'bun:test';
import { mentionedUsernames } from './push';

describe('mentionedUsernames', () => {
  it('finds @names, ignores emails, trailing dots and duplicates', () => {
    expect(mentionedUsernames('hi @Bob, see @alice.smith. mail me at x@example.com and @bob')).toEqual(['bob', 'alice.smith']);
    expect(mentionedUsernames('no mentions here')).toEqual([]);
  });
});
