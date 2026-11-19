import { describe, test, expect } from 'bun:test';
import { isAllowed, classify, normalizeScopes } from './token-scopes';

describe('token scopes', () => {
  test('classification', () => {
    expect(classify('/rest/api/2/issue/ABC-1/comment')).toBe('issues');
    expect(classify('/rest/api/2/issuetype')).toBe('common');
    expect(classify('/rest/api/2/issueLink')).toBe('issues');
    expect(classify('/rest/api/2/project/ABC')).toBe('projects');
    expect(classify('/rest/api/2/admin/oidc')).toBe('admin');
    expect(classify('//rest/api/2/ADMIN/oidc')).toBe('admin');
    expect(classify('/scim/v2/Users')).toBe('admin');
    expect(classify('/rest/api/2/migration/run')).toBe('admin');
    expect(classify('/rest/api/2/mypersonalaccessTokens')).toBe('admin');
    expect(classify('/rest/api/2/group')).toBe('other');
  });
  test('wildcard and admin allow everything', () => {
    expect(isAllowed(['*'], 'DELETE', '/rest/api/2/admin/oidc/1')).toBe(true);
    expect(isAllowed(['admin'], 'POST', '/scim/v2/Users')).toBe(true);
  });
  test('read:* is GET/HEAD only and not admin', () => {
    const s = ['read:*'];
    expect(isAllowed(s, 'GET', '/rest/api/2/issue/A-1')).toBe(true);
    expect(isAllowed(s, 'HEAD', '/rest/api/2/project')).toBe(true);
    expect(isAllowed(s, 'POST', '/rest/api/2/issue')).toBe(false);
    expect(isAllowed(s, 'PUT', '/rest/api/2/issue/A-1')).toBe(false);
    expect(isAllowed(s, 'DELETE', '/rest/api/2/issue/A-1')).toBe(false);
    expect(isAllowed(s, 'GET', '/rest/api/2/admin/oidc')).toBe(false);
    expect(isAllowed(s, 'POST', '/rest/api/2/search')).toBe(true); // JQL search is a read
  });
  test('write:issues covers issue subresources only', () => {
    const s = ['write:issues'];
    expect(isAllowed(s, 'POST', '/rest/api/2/issue/A-1/comment')).toBe(true);
    expect(isAllowed(s, 'POST', '/rest/api/2/issue/A-1/worklog')).toBe(true);
    expect(isAllowed(s, 'POST', '/rest/api/2/issue/A-1/attachments')).toBe(true);
    expect(isAllowed(s, 'GET', '/rest/api/2/issue/A-1')).toBe(true);
    expect(isAllowed(s, 'POST', '/rest/api/2/project')).toBe(false);
    expect(isAllowed(s, 'GET', '/rest/api/2/project')).toBe(false);
    expect(isAllowed(s, 'GET', '/rest/api/2/group')).toBe(false);
    expect(isAllowed(s, 'POST', '/rest/api/2/mypersonalaccessTokens')).toBe(false);
  });
  test('read:issues cannot write and cannot read projects', () => {
    const s = ['read:issues'];
    expect(isAllowed(s, 'GET', '/rest/api/2/issue/A-1')).toBe(true);
    expect(isAllowed(s, 'POST', '/rest/api/2/issue/A-1/comment')).toBe(false);
    expect(isAllowed(s, 'GET', '/rest/api/2/project')).toBe(false);
    expect(isAllowed(s, 'GET', '/rest/api/2/myself')).toBe(true);
  });
  test('empty or unknown scopes deny everything', () => {
    expect(isAllowed([], 'GET', '/rest/api/2/myself')).toBe(false);
    expect(isAllowed(['bogus'], 'GET', '/rest/api/2/issue/A-1')).toBe(false);
  });
  test('legacy read/write tokens', () => {
    expect(normalizeScopes(['read', 'write'])).toEqual(['*']);
    expect(normalizeScopes(['read'])).toEqual(['read:*']);
    expect(normalizeScopes('x')).toEqual([]);
  });
});
