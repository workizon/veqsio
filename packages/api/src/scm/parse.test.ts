import { describe, test, expect } from 'bun:test';
import { extractIssueKeys, parseSmartCommits, verifyWebhook, hmacHex, parseWebhook } from './parse';

describe('extractIssueKeys', () => {
  test('finds keys in messages and lower-case branch names', () => {
    expect(extractIssueKeys('PROJ-12 fix and ABC-3', 'feature/proj-12-login')).toEqual(['PROJ-12', 'ABC-3']);
    expect(extractIssueKeys('no keys here', 'release-notes')).toEqual([]);
  });
});

describe('parseSmartCommits', () => {
  test('comment and transition', () => {
    expect(parseSmartCommits('PROJ-1 #comment looks good #in-progress')).toEqual([{ key: 'PROJ-1', comment: 'looks good', transition: 'in progress' }]);
    expect(parseSmartCommits('fix thing PROJ-2 #done\nPROJ-3 #comment hi')).toEqual([{ key: 'PROJ-2', transition: 'done' }, { key: 'PROJ-3', comment: 'hi' }]);
    expect(parseSmartCommits('PROJ-1 plain message')).toEqual([]);
  });
});

describe('verifyWebhook', () => {
  const body = '{"a":1}';
  test('github / gitea HMAC', () => {
    const sig = hmacHex('s3cret', body);
    expect(verifyWebhook('github', (n) => ({ 'x-hub-signature-256': `sha256=${sig}` } as any)[n], body, 's3cret')).toBe(true);
    expect(verifyWebhook('github', (n) => ({ 'x-hub-signature-256': `sha256=${sig}` } as any)[n], body, 'other')).toBe(false);
    expect(verifyWebhook('github', () => undefined, body, 's3cret')).toBe(false);
    expect(verifyWebhook('gitea', (n) => ({ 'x-gitea-signature': sig } as any)[n], body, 's3cret')).toBe(true);
  });
  test('gitlab token and bitbucket query token', () => {
    expect(verifyWebhook('gitlab', (n) => ({ 'x-gitlab-token': 'abc' } as any)[n], body, 'abc')).toBe(true);
    expect(verifyWebhook('gitlab', () => 'nope', body, 'abc')).toBe(false);
    expect(verifyWebhook('bitbucket', () => undefined, body, 'abc', 'abc')).toBe(true);
    expect(verifyWebhook('bitbucket', () => undefined, body, 'abc')).toBe(false);
  });
});

describe('parseWebhook', () => {
  test('github push and pull request', () => {
    const push = parseWebhook('github', 'push', { ref: 'refs/heads/proj-1-x', repository: { html_url: 'https://github.com/o/r' }, commits: [{ id: 'abc', message: 'PROJ-1 hi', url: 'u', author: { name: 'A', email: 'a@x.io' } }] });
    expect(push.map((e) => e.kind)).toEqual(['branch', 'commit']);
    expect(push[1].authorEmail).toBe('a@x.io');
    const pr = parseWebhook('github', 'pull_request', { pull_request: { number: 7, title: 'PROJ-1 add', html_url: 'u', state: 'closed', merged: true, head: { ref: 'b' } } });
    expect(pr[0]).toMatchObject({ kind: 'pull_request', ref: '7', status: 'merged' });
  });
  test('gitlab merge request and pipeline, bitbucket push, junk', () => {
    expect(parseWebhook('gitlab', 'Merge Request Hook', { object_attributes: { iid: 3, title: 'T', url: 'u', state: 'opened', source_branch: 'b' } })[0].status).toBe('open');
    expect(parseWebhook('gitlab', 'Pipeline Hook', { object_attributes: { ref: 'b', status: 'success', id: 1 }, project: { web_url: 'w' } })[0]).toMatchObject({ kind: 'build', status: 'success' });
    expect(parseWebhook('bitbucket', 'repo:push', { push: { changes: [{ new: { type: 'branch', name: 'b' }, commits: [{ hash: 'h', message: 'PROJ-2 m', author: { raw: 'N <n@x.io>' } }] }] } }).length).toBe(2);
    expect(parseWebhook('github', 'ping', {})).toEqual([]);
    expect(parseWebhook('github', 'push', null)).toEqual([]);
  });
});
