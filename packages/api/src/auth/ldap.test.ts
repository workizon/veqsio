import { describe, test, expect } from 'bun:test';
import { attributeToStrings, escapeDnValue, escapeFilterValue, guardedBind, isValidFilter, normalizeDn, LdapError, type LdapClient } from './ldap-client';
import { buildGroupMembers, entryToUser, planSync, userLookupFilter, type DirUser, type ExistingIdentity, type PlanInput } from './ldap-service';
import { parseFilter } from '../../tests/fake-ldap';

describe('RFC 4515 filter escaping', () => {
  test('escapes the special characters and NUL', () => {
    expect(escapeFilterValue('a*b(c)d\\e')).toBe('a\\2ab\\28c\\29d\\5ce');
    expect(escapeFilterValue('x\u0000y')).toBe('x\\00y');
    expect(escapeFilterValue('plain.user-1')).toBe('plain.user-1');
    expect(escapeFilterValue('é')).toBe('\\c3\\a9');
  });
  test('injection payloads stay a single literal value', () => {
    for (const p of ['*', 'x)(uid=*', '*)(objectClass=*', ')(|(a=b', '\\']) {
      const f = userLookupFilter({ userFilter: '(objectClass=person)', usernameAttribute: 'uid' }, p);
      expect(isValidFilter(f)).toBe(true);
      const tree = parseFilter(f) as any; // throws on unbalanced structure
      expect(tree.op).toBe('&');
      expect(tree.kids).toHaveLength(2);
      expect(tree.kids[1].op).toBe('=');
    }
  });
});

describe('RFC 4514 DN escaping and comparison', () => {
  test('escapes DN specials, leading # or space, trailing space', () => {
    expect(escapeDnValue('Smith, John')).toBe('Smith\\, John');
    expect(escapeDnValue('a+b="c"<d>;e\\')).toBe('a\\+b\\=\\"c\\"\\<d\\>\\;e\\\\');
    expect(escapeDnValue('#hash')).toBe('\\#hash');
    expect(escapeDnValue(' lead')).toBe('\\ lead');
    expect(escapeDnValue('trail ')).toBe('trail\\ ');
    expect(escapeDnValue('a\u0000b')).toBe('a\\00b');
  });
  test('normalizeDn ignores case and spacing around separators', () => {
    expect(normalizeDn('UID=Jane , OU=People,DC=Example,DC=com')).toBe(normalizeDn('uid=jane,ou=people,dc=example,dc=com'));
  });
});

describe('isValidFilter', () => {
  test('requires exactly one balanced parenthesised expression', () => {
    for (const ok of ['(objectClass=person)', '(&(a=b)(c=d))', '(|(a=b)(!(c=d)))', '(cn=a\\29b)']) expect(isValidFilter(ok)).toBe(true);
    for (const bad of ['objectClass=person', '(a=b', '(a=b))', '(a=b)(c=d)', '', '()(']) expect(isValidFilter(bad)).toBe(false);
  });
});

describe('guardedBind', () => {
  const calls: string[] = [];
  const client: LdapClient = { async bind(dn) { calls.push(dn); }, async search() { return { entries: [], truncated: false }; }, async close() {} };
  test('refuses empty DN, empty password and NUL bytes without touching the server', async () => {
    for (const [dn, pw] of [['', 'x'], ['  ', 'x'], ['cn=a', ''], ['cn=a', 'a\u0000b']] as const) {
      await expect(guardedBind(client, dn, pw)).rejects.toBeInstanceOf(LdapError);
    }
    expect(calls).toEqual([]);
    await guardedBind(client, 'cn=a', 'x');
    expect(calls).toEqual(['cn=a']);
  });
});

describe('attributeToStrings', () => {
  test('objectGUID becomes the canonical GUID text, other binary hex, strings pass through', () => {
    const guid = Buffer.from([0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    expect(attributeToStrings('objectGUID', guid)).toEqual(['00112233-4455-6677-8899-aabbccddeeff']);
    expect(attributeToStrings('cn', ['a', 'b'])).toEqual(['a', 'b']);
    expect(attributeToStrings('x', Buffer.from([0xff, 0x00, 0x01]))).toEqual(['ff0001']);
  });
});

const dirCfg = { usernameAttribute: 'sAMAccountName', emailAttribute: 'mail', displayNameAttribute: 'displayName', uniqueIdAttribute: 'objectGUID' };
describe('entryToUser', () => {
  test('maps attributes case-insensitively and falls back to the DN as key', () => {
    const u = entryToUser(dirCfg, { dn: 'CN=Jane,OU=P,DC=x', attrs: { SAMAccountName: ['jane'], MAIL: ['Jane@X.com'], displayName: ['Jane D'], objectGUID: ['guid-1'] } });
    expect(u).toEqual({ key: 'guid-1', dn: 'CN=Jane,OU=P,DC=x', username: 'jane', email: 'jane@x.com', name: 'Jane D' });
    expect(entryToUser(dirCfg, { dn: 'CN=Jane , OU=P,DC=x', attrs: { mail: ['bad'] } })).toMatchObject({ key: 'dn:cn=jane,ou=p,dc=x', email: null });
  });
});

describe('buildGroupMembers', () => {
  const users: DirUser[] = ['a', 'b', 'c'].map((n) => ({ key: n, dn: `uid=${n},dc=x`, username: n, email: `${n}@x`, name: n }));
  const g = (cn: string, members: string[], attr = 'member') => ({ dn: `cn=${cn},ou=g,dc=x`, attrs: { cn: [cn], [attr]: members } });
  const base = { groupNameAttribute: 'cn', groupMemberAttribute: 'member', nestedGroups: false };
  test('direct membership, DN spelling differences, empty groups skipped', () => {
    const m = buildGroupMembers(base, [g('eng', ['UID=A, DC=x', 'uid=b,dc=x']), g('empty', ['uid=zzz,dc=x'])], users);
    expect([...m.keys()]).toEqual(['eng']);
    expect([...m.get('eng')!].sort()).toEqual(['a', 'b']);
  });
  test('nested groups only when enabled, cycles terminate', () => {
    const groups = [g('outer', ['cn=inner,ou=g,dc=x', 'uid=c,dc=x']), g('inner', ['uid=a,dc=x', 'cn=outer,ou=g,dc=x'])];
    expect([...buildGroupMembers(base, groups, users).get('outer')!]).toEqual(['c']);
    expect([...buildGroupMembers({ ...base, nestedGroups: true }, groups, users).get('outer')!].sort()).toEqual(['a', 'c']);
  });
  test('memberUid matches login names', () => {
    const m = buildGroupMembers({ ...base, groupMemberAttribute: 'memberUid' }, [g('posix', ['a', 'C'], 'memberUid')], users);
    expect([...m.get('posix')!].sort()).toEqual(['a', 'c']);
  });
});

describe('planSync', () => {
  const du = (n: string, over: Partial<DirUser> = {}): DirUser => ({ key: n, dn: `uid=${n},dc=x`, username: n, email: `${n}@x.com`, name: n.toUpperCase(), ...over });
  const ex = (n: string, userId: number, over: Partial<ExistingIdentity> = {}): ExistingIdentity => ({ identityId: userId * 10, userId, key: n, active: true, email: `${n}@x.com`, displayName: n.toUpperCase(), syncedGroups: [], deactivatedBySync: false, ...over });
  const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    autoProvision: true, linkByEmail: false, deactivateMissing: true, users: [], existing: [], emailOwners: new Map(), groups: new Map(), memberships: new Map(), seatsFree: null, ...over,
  });

  test('creates, updates, deactivates and counts group changes', () => {
    const p = planSync(input({
      users: [du('new'), du('kept', { name: 'Changed' }), du('same')],
      existing: [ex('kept', 1), ex('same', 2), ex('gone', 3)],
      groups: new Map([['eng', new Set(['new', 'same'])]]),
      memberships: new Map([[2, new Set(['old'])]]),
    }), new Set(['old']));
    expect(p.counts).toMatchObject({ directoryUsers: 3, create: 1, update: 1, deactivate: 1, groupsCreate: 1, membershipsAdd: 2, membershipsRemove: 0 });
    expect(p.deactivate.map((d) => d.key)).toEqual(['gone']);
    expect(p.users.find((u) => u.key === 'kept')).toMatchObject({ action: 'update', setName: true, setEmail: false });
  });
  test('removes only previously synced memberships that are still present', () => {
    const p = planSync(input({
      users: [du('a')], existing: [ex('a', 1, { syncedGroups: ['x', 'y'] })], groups: new Map([['x', new Set(['a'])]]),
      memberships: new Map([[1, new Set(['x', 'y', 'manual'])]]),
    }), new Set(['x', 'y', 'manual']));
    expect(p.counts.membershipsRemove).toBe(1); // y only; "manual" was never synced
  });
  test('skip reasons: no email, duplicates, email in use, manual deactivation, not provisioned', () => {
    const p = planSync(input({
      users: [du('a', { email: null }), du('b', { email: 'd@x.com' }), du('c', { email: 'd@x.com' }), du('d', { email: 'taken@x.com' }), du('e')],
      existing: [ex('e', 9, { active: false })],
      emailOwners: new Map([['taken@x.com', { userId: 7, active: true, linkedToThis: false }]]),
    }), new Set());
    expect(Object.fromEntries(p.skipped.map((s) => [s.key, s.reason]))).toEqual({ a: 'no_email', c: 'duplicate_email', d: 'email_in_use', e: 'deactivated_manually' });
    expect(planSync(input({ users: [du('z')], autoProvision: false }), new Set()).skipped).toEqual([{ key: 'z', reason: 'not_provisioned' }]);
  });
  test('link by email, reactivation of sync-deactivated users, seat limit', () => {
    const owners = new Map([['l@x.com', { userId: 7, active: true, linkedToThis: false }]]);
    const p = planSync(input({
      linkByEmail: true, users: [du('l'), du('r'), du('n1'), du('n2')], emailOwners: owners,
      existing: [ex('r', 4, { active: false, deactivatedBySync: true })], seatsFree: 2,
    }), new Set());
    expect(p.counts).toMatchObject({ link: 1, reactivate: 1, create: 1 });
    expect(p.skipped).toEqual([{ key: 'n2', reason: 'seat_limit' }]);
  });
  test('deactivateMissing off keeps everyone', () => {
    expect(planSync(input({ deactivateMissing: false, existing: [ex('gone', 3)] }), new Set()).counts.deactivate).toBe(0);
  });
});
