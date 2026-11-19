import { describe, expect, test } from 'bun:test';
import { isOverdue, issueMilestonesBody, issuesOutsideProject, milestoneCreateBody, milestoneProgress, milestoneUpdateBody } from './rules';

describe('milestone rules', () => {
  test('issuesOutsideProject lists issues of other projects', () => {
    expect(issuesOutsideProject([{ key: 'A-1', projectId: 1 }, { key: 'B-1', projectId: 2 }], 1)).toEqual(['B-1']);
    expect(issuesOutsideProject([{ key: 'A-1', projectId: 1 }], 1)).toEqual([]);
  });
  test('progress excludes cancelled', () => {
    const p = milestoneProgress([{ category: 'done' }, { category: 'to_do' }, { category: 'cancelled' }, { category: 'in_progress' }]);
    expect(p).toMatchObject({ total: 3, done: 1, cancelled: 1, percentDone: 33, issueCount: 4 });
    expect(milestoneProgress([])).toMatchObject({ total: 0, percentDone: 0 });
  });
  test('overdue only for open milestones with a past target', () => {
    expect(isOverdue({ state: 'open', targetDate: '2026-01-01' }, '2026-01-02')).toBe(true);
    expect(isOverdue({ state: 'open', targetDate: '2026-01-02' }, '2026-01-02')).toBe(false);
    expect(isOverdue({ state: 'reached', targetDate: '2026-01-01' }, '2026-01-02')).toBe(false);
    expect(isOverdue({ state: 'open', targetDate: null }, '2026-01-02')).toBe(false);
  });
  test('bodies are strict', () => {
    expect(milestoneCreateBody.safeParse({ name: 'M1', targetDate: '2026-05-01' }).success).toBe(true);
    expect(milestoneCreateBody.safeParse({ name: '', targetDate: null }).success).toBe(false);
    expect(milestoneCreateBody.safeParse({ name: 'M', targetDate: '05/01/2026' }).success).toBe(false);
    expect(milestoneUpdateBody.safeParse({ state: 'done' }).success).toBe(false);
    expect(milestoneUpdateBody.safeParse({ state: 'reached', project: 1 }).success).toBe(false);
    expect(issueMilestonesBody.safeParse({ milestoneIds: [1, 2] }).success).toBe(true);
    expect(issueMilestonesBody.safeParse({ milestoneIds: [0] }).success).toBe(false);
  });
});
