import { describe, expect, test } from 'bun:test';
import { buildReview, type ReviewInput } from './permission-review';

const base = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  project: { id: 1, key: 'OPS', name: 'Ops', leadId: 1 },
  scheme: { id: 1, name: 'Default' },
  entries: [],
  users: [
    { id: 1, username: 'ann', displayName: 'Ann', email: 'a@x', active: true },
    { id: 2, username: 'bob', displayName: 'Bob', email: 'b@x', active: true },
    { id: 3, username: 'old', displayName: 'Old', email: 'o@x', active: false },
  ],
  groups: [{ id: 10, name: 'dev' }, { id: 11, name: 'empty' }],
  members: [{ userId: 2, groupId: 10 }, { userId: 3, groupId: 10 }],
  roles: [{ id: 20, name: 'Developers' }],
  actors: [{ roleId: 20, userId: 1, groupId: null }, { roleId: 20, userId: null, groupId: 10 }],
  ...over,
});
const e = (permissionKey: string, o: Partial<ReviewInput['entries'][number]> = {}) => ({ permissionKey, userId: null, groupId: null, projectRoleId: null, anyUser: false, projectLead: false, anonymous: false, ...o });

describe('permission review', () => {
  test('expands groups, roles (also through groups), direct grants and the lead', () => {
    const r = buildReview(base({ entries: [e('EDIT_ISSUES', { groupId: 10 }), e('CREATE_ISSUES', { projectRoleId: 20 }), e('PROJECT_ADMIN', { projectLead: true }), e('BROWSE_PROJECTS', { userId: 1 })] }));
    const ann = r.people.find((p) => p.username === 'ann')!;
    expect(ann.permissions.map((p) => p.key)).toEqual(['BROWSE_PROJECTS', 'CREATE_ISSUES', 'PROJECT_ADMIN']);
    const bob = r.people.find((p) => p.username === 'bob')!;
    expect(bob.permissions.find((p) => p.key === 'CREATE_ISSUES')!.via[0]).toMatchObject({ type: 'role', name: 'Developers', group: 'dev' });
    expect(bob.permissions.find((p) => p.key === 'EDIT_ISSUES')!.via[0]).toMatchObject({ type: 'group', name: 'dev' });
    expect(r.counts.directGrants).toBe(1);
    expect(r.counts.admins).toBe(1);
  });
  test('findings: anonymous write is high, inactive access, direct grants, everyone write', () => {
    const r = buildReview(base({ entries: [e('DELETE_ISSUES', { anonymous: true }), e('EDIT_ISSUES', { anyUser: true }), e('BROWSE_PROJECTS', { groupId: 10 }), e('BROWSE_PROJECTS', { userId: 2 })] }));
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain('anonymous-write');
    expect(codes).toContain('everyone-write');
    expect(codes).toContain('inactive-access');
    expect(codes).toContain('direct-grants');
    expect(r.findings[0].severity).toBe('high');
  });
  test('public browse only is a medium finding; an empty group holding permissions is noted', () => {
    const r = buildReview(base({ entries: [e('BROWSE_PROJECTS', { anonymous: true }), e('EDIT_ISSUES', { groupId: 11 })] }));
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['anonymous-browse', 'empty-group']));
    expect(r.findings.some((f) => f.code === 'anonymous-write')).toBe(false);
  });
  test('a project without a scheme is reported, nobody has access', () => {
    const r = buildReview(base({ scheme: null, entries: [] }));
    expect(r.people).toHaveLength(0);
    expect(r.findings[0].code).toBe('no-scheme');
  });
});
