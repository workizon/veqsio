import { describe, expect, test } from 'bun:test';
import {
  canManageInitiative, canReadInitiative, initiativeCreateBody, initiativeLinkBody, initiativeUpdateBody, rollupProgress, trimToVisible, validateInitiativeDates,
} from './rollup';

describe('rollupProgress', () => {
  const issues = [
    { id: 1, projectId: 1, category: 'done' },
    { id: 2, projectId: 1, category: 'in_progress' },
    { id: 3, projectId: 1, category: 'to_do' },
    { id: 4, projectId: 1, category: 'cancelled' },
    { id: 5, projectId: 2, category: 'done' },
  ];
  test('excludes cancelled from total and percent', () => {
    const r = rollupProgress(issues, new Set([1]));
    expect(r).toMatchObject({ total: 3, done: 1, inProgress: 1, todo: 1, cancelled: 1, percentDone: 33, issueCount: 4 });
  });
  test('counts only issues of visible projects', () => {
    expect(rollupProgress(issues, new Set([2]))).toMatchObject({ total: 1, done: 1, percentDone: 100 });
    expect(rollupProgress(issues, new Set())).toMatchObject({ total: 0, percentDone: 0, issueCount: 0 });
  });
  test('an issue reached twice counts once; backlog counts as to do', () => {
    const r = rollupProgress([...issues, { id: 1, projectId: 1, category: 'done' }, { id: 6, projectId: 1, category: 'backlog' }], new Set([1]));
    expect(r.issueCount).toBe(5);
    expect(r.todo).toBe(2);
  });
});

describe('permission rules', () => {
  test('trimToVisible keeps only browsable projects', () => {
    const items = [{ k: 'A', projectId: 1 }, { k: 'B', projectId: 2 }];
    expect(trimToVisible(items, new Set([2]))).toEqual([{ k: 'B', projectId: 2 }]);
    expect(trimToVisible(items, new Set())).toEqual([]);
  });
  test('read: admin, owner, or at least one visible link', () => {
    expect(canReadInitiative({ isAdmin: false, isOwner: false, visibleLinkCount: 0 })).toBe(false);
    expect(canReadInitiative({ isAdmin: false, isOwner: false, visibleLinkCount: 1 })).toBe(true);
    expect(canReadInitiative({ isAdmin: false, isOwner: true, visibleLinkCount: 0 })).toBe(true);
    expect(canReadInitiative({ isAdmin: true, isOwner: false, visibleLinkCount: 0 })).toBe(true);
  });
  test('manage: owner or admin only', () => {
    expect(canManageInitiative({ isAdmin: false, isOwner: false })).toBe(false);
    expect(canManageInitiative({ isAdmin: false, isOwner: true })).toBe(true);
    expect(canManageInitiative({ isAdmin: true, isOwner: false })).toBe(true);
  });
});

describe('validation', () => {
  test('dates', () => {
    expect(validateInitiativeDates('2026-01-10', '2026-01-09')).toMatch(/before/);
    expect(validateInitiativeDates('2026-01-10', '2026-01-10')).toBeNull();
    expect(validateInitiativeDates(null, '2026-01-10')).toBeNull();
  });
  test('bodies are strict', () => {
    expect(initiativeCreateBody.safeParse({ name: 'X', extra: 1 }).success).toBe(false);
    expect(initiativeCreateBody.safeParse({ name: '  ' }).success).toBe(false);
    expect(initiativeCreateBody.safeParse({ name: 'X', status: 'nope' }).success).toBe(false);
    expect(initiativeCreateBody.parse({ name: 'X' })).toMatchObject({ status: 'planned', description: '' });
    expect(initiativeUpdateBody.safeParse({ startDate: '2026-13-45' }).success).toBe(false);
    expect(initiativeLinkBody.safeParse({}).success).toBe(false);
    expect(initiativeLinkBody.safeParse({ projectKey: 'A', issueKey: 'A-1' }).success).toBe(false);
    expect(initiativeLinkBody.safeParse({ issueKey: 'A-1' }).success).toBe(true);
  });
});
