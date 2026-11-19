import { describe, expect, test } from 'bun:test';
import { baseCategory, countsTowardProgress, groupOf, isDoneLike, reportCategory, summarizeProgress } from './status-groups';
import { normalizeCategory } from './transition-meta';

describe('status groups', () => {
  test('groupOf knows all spellings and keeps legacy behaviour', () => {
    expect(groupOf('to_do')).toBe('to_do');
    expect(groupOf('todo')).toBe('to_do');
    expect(groupOf('Unstarted')).toBe('to_do');
    expect(groupOf('')).toBe('to_do');
    expect(groupOf(null)).toBe('to_do');
    expect(groupOf('in-progress')).toBe('in_progress');
    expect(groupOf('indeterminate')).toBe('in_progress'); // unknown spellings stay "in progress" as before
    expect(groupOf('Completed')).toBe('done');
    expect(groupOf('backlog')).toBe('backlog');
    expect(groupOf('Canceled')).toBe('cancelled');
    expect(groupOf('cancelled')).toBe('cancelled');
  });

  test('baseCategory folds backlog into todo and cancelled into done', () => {
    expect(baseCategory('backlog')).toBe('todo');
    expect(baseCategory('cancelled')).toBe('done');
    expect(baseCategory('done')).toBe('done');
    expect(baseCategory('in_progress')).toBe('in_progress');
    // the workflow engine's normalizer is the same function: a cancelled target needs a resolution like done
    expect(normalizeCategory('cancelled')).toBe('done');
    expect(normalizeCategory('backlog')).toBe('todo');
  });

  test('cancelled is done-like but not progress', () => {
    expect(isDoneLike('cancelled')).toBe(true);
    expect(isDoneLike('backlog')).toBe(false);
    expect(countsTowardProgress('cancelled')).toBe(false);
    expect(countsTowardProgress('done')).toBe(true);
    expect(reportCategory('cancelled')).toBe('cancelled');
    expect(reportCategory('backlog')).toBe('todo');
  });

  test('summarizeProgress leaves cancelled out of total and percent', () => {
    const s = summarizeProgress([
      { category: 'done' }, { category: 'done' }, { category: 'cancelled' }, { category: 'cancelled' },
      { category: 'in_progress' }, { category: 'backlog' },
    ]);
    expect(s).toEqual({ total: 4, done: 2, inProgress: 1, todo: 1, cancelled: 2, percentDone: 50 });
    expect(summarizeProgress([{ category: 'cancelled' }]).percentDone).toBe(0);
    expect(summarizeProgress([{ category: 'done', size: 3 }, { category: 'todo', size: 1 }]).percentDone).toBe(75);
  });
});
