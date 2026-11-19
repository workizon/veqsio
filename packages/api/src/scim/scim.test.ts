import { describe, test, expect } from 'bun:test';
import { parseFilter } from './filter';
import { applyUserPatch, applyGroupPatch, type UserModel } from './patch';
import { parseUserBody, parseGroupBody, pageParams } from './mapping';
import { ScimError } from './errors';

const user: UserModel = { userName: 'a@x.io', displayName: 'A', givenName: null, familyName: null, email: 'a@x.io', active: true, externalId: null };

describe('scim filter parser', () => {
  test('simple eq', () => {
    expect(parseFilter('userName eq "bjensen@example.com"')).toEqual({ type: 'cmp', attr: 'userName', op: 'eq', value: 'bjensen@example.com' });
  });
  test('and / or / not / pr / booleans, precedence', () => {
    const f = parseFilter('active eq true and (userName sw "a" or not (displayName co "x")) or externalId pr');
    expect(f.type).toBe('or');
    expect((f as any).left.type).toBe('and');
    expect((f as any).right).toEqual({ type: 'pr', attr: 'externalId' });
  });
  test('escaped quotes', () => {
    expect((parseFilter('userName eq "a\\"b"') as any).value).toBe('a"b');
  });
  test('rejects garbage', () => {
    for (const bad of ['', 'userName', 'userName eq', 'userName foo "x"', 'userName eq "x', '(userName eq "x"', 'userName eq "x" )', 'emails[type eq "work"] eq "x"', 'userName eq x']) {
      expect(() => parseFilter(bad)).toThrow(ScimError);
    }
    expect(() => parseFilter('a eq "' + 'x'.repeat(2000) + '"')).toThrow(ScimError);
    expect(() => parseFilter('('.repeat(50) + 'a pr' + ')'.repeat(50))).toThrow(ScimError);
  });
});

describe('scim user patch', () => {
  test('deactivate with boolean, string "False" (Entra) and pathless object (Okta)', () => {
    expect(applyUserPatch(user, { Operations: [{ op: 'replace', path: 'active', value: false }] }).active).toBe(false);
    expect(applyUserPatch(user, { Operations: [{ op: 'Replace', path: 'active', value: 'False' }] }).active).toBe(false);
    expect(applyUserPatch(user, { Operations: [{ op: 'replace', value: { active: false } }] }).active).toBe(false);
  });
  test('email, name and displayName', () => {
    const r = applyUserPatch(user, { Operations: [
      { op: 'replace', path: 'emails[type eq "work"].value', value: 'New@X.io' },
      { op: 'add', path: 'name.givenName', value: 'Ann' },
      { op: 'replace', path: 'displayName', value: 'Ann B' },
      { op: 'replace', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'x' },
    ] });
    expect(r).toMatchObject({ email: 'new@x.io', givenName: 'Ann', displayName: 'Ann B' });
  });
  test('remove externalId ok; userName/active removal refused; bad values refused', () => {
    expect(applyUserPatch({ ...user, externalId: 'e' }, { Operations: [{ op: 'remove', path: 'externalId' }] }).externalId).toBeNull();
    expect(() => applyUserPatch(user, { Operations: [{ op: 'remove', path: 'userName' }] })).toThrow(ScimError);
    expect(() => applyUserPatch(user, { Operations: [{ op: 'remove', path: 'active' }] })).toThrow(ScimError);
    expect(() => applyUserPatch(user, { Operations: [{ op: 'replace', path: 'active', value: 'maybe' }] })).toThrow(ScimError);
    expect(() => applyUserPatch(user, { Operations: [{ op: 'move', path: 'active' }] })).toThrow(ScimError);
    expect(() => applyUserPatch(user, {})).toThrow(ScimError);
  });
  test('does not mutate input', () => {
    applyUserPatch(user, { Operations: [{ op: 'replace', path: 'active', value: false }] });
    expect(user.active).toBe(true);
  });
});

describe('scim group patch', () => {
  const g = { displayName: 'G', memberIds: ['1', '2'] };
  test('add, remove by filter, remove all, replace', () => {
    expect(applyGroupPatch(g, { Operations: [{ op: 'add', path: 'members', value: [{ value: '3' }, { value: '1' }] }] }).memberIds).toEqual(['1', '2', '3']);
    expect(applyGroupPatch(g, { Operations: [{ op: 'remove', path: 'members[value eq "1"]' }] }).memberIds).toEqual(['2']);
    expect(applyGroupPatch(g, { Operations: [{ op: 'remove', path: 'members' }] }).memberIds).toEqual([]);
    expect(applyGroupPatch(g, { Operations: [{ op: 'remove', path: 'members', value: [{ value: '2' }] }] }).memberIds).toEqual(['1']);
    expect(applyGroupPatch(g, { Operations: [{ op: 'replace', path: 'members', value: [{ value: '9' }] }] }).memberIds).toEqual(['9']);
    expect(applyGroupPatch(g, { Operations: [{ op: 'replace', path: 'displayName', value: 'H' }] }).displayName).toBe('H');
  });
  test('rejects malformed members', () => {
    expect(() => applyGroupPatch(g, { Operations: [{ op: 'add', path: 'members', value: [{ nope: 1 }] }] })).toThrow(ScimError);
  });
});

describe('scim mapping', () => {
  test('parseUserBody derives email from userName, handles string active', () => {
    expect(parseUserBody({ userName: 'Bob@X.io', active: 'false' })).toMatchObject({ userName: 'bob@x.io', email: 'bob@x.io', active: false });
    expect(parseUserBody({ userName: 'bob', emails: [{ value: 'b@x.io', primary: true }], unknown: 1 }).email).toBe('b@x.io');
    expect(() => parseUserBody({ userName: 'bob' })).toThrow(ScimError);
    expect(() => parseUserBody({})).toThrow(ScimError);
  });
  test('parseGroupBody dedupes members', () => {
    expect(parseGroupBody({ displayName: 'G', members: [{ value: '1' }, { value: '1' }] }).memberIds).toEqual(['1']);
  });
  test('pageParams clamps', () => {
    expect(pageParams(undefined, undefined)).toEqual({ startIndex: 1, count: 100 });
    expect(pageParams('0', '-5')).toEqual({ startIndex: 1, count: 0 });
    expect(pageParams('3', '99999')).toEqual({ startIndex: 3, count: 200 });
  });
});
