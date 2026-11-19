import { describe, test, expect } from 'bun:test';
import { collapseDiff, diffLines, diffSummary, splitLines } from './diff';
import { canEditPage, canLockPage, canModeratePage, type PageFacts } from './rules';
import { descendantIds, nextPosition, orderTree, reorderSiblings, wouldCreateCycle } from './tree';
import { summaryFromText } from '../routes/pages';

describe('page diff', () => {
  test('identical and empty inputs', () => {
    expect(diffSummary('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
    expect(diffSummary('', '')).toEqual({ added: 0, removed: 0 });
    expect(splitLines('')).toEqual([]);
    expect(diffSummary('', 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
    expect(diffSummary('a\nb', '')).toEqual({ added: 0, removed: 2 });
  });

  test('additions, removals and changes', () => {
    expect(diffSummary('a\nb\nc', 'a\nb\nc\nd')).toEqual({ added: 1, removed: 0 });
    expect(diffSummary('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
    expect(diffSummary('a\nb\nc', 'a\nX\nc')).toEqual({ added: 1, removed: 1 });
    const ops = diffLines('one\ntwo\nthree', 'one\n2\nthree');
    expect(ops.map((o) => `${o.type}:${o.text}`)).toEqual(['eq:one', 'del:two', 'add:2', 'eq:three']);
  });

  test('CRLF and LF are the same text', () => {
    expect(diffSummary('a\r\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
  });

  test('moved blocks are found through the common subsequence', () => {
    const d = diffSummary('a\nb\nc\nd\ne', 'a\nc\nd\nb\ne');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });

  test('collapseDiff keeps context and marks skipped runs', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'CHANGED');
    const hunks = collapseDiff(diffLines(before, after), 2);
    expect(hunks[0]).toEqual({ type: 'skip', count: 8 });
    expect(hunks.filter((h) => h.type === 'add')).toHaveLength(1);
    expect(hunks[hunks.length - 1]).toEqual({ type: 'skip', count: 7 });
    expect(collapseDiff(diffLines('a', 'a'))).toEqual([{ type: 'skip', count: 1 }]);
  });

  test('huge unrelated middles degrade to remove-all/add-all instead of hanging', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    expect(diffSummary(a, b)).toEqual({ added: 3000, removed: 3000 });
  });
});

describe('page tree helpers', () => {
  const n = (id: number, parentId: number | null, position: number, title = `P${id}`) => ({ id, parentId, position, title });

  test('orderTree sorts siblings by position then title and walks depth first', () => {
    const out = orderTree([n(1, null, 1, 'B'), n(2, null, 0, 'A'), n(3, 2, 1, 'z'), n(4, 2, 0, 'y'), n(5, 1, 0, 'c')]);
    expect(out.map((x) => [x.id, x.depth])).toEqual([[2, 0], [4, 1], [3, 1], [1, 0], [5, 1]]);
  });

  test('equal positions fall back to title and id; orphans become top level; cycles do not loop', () => {
    const out = orderTree([n(1, null, 0, 'same'), n(2, null, 0, 'Same'), n(3, 99, 0, 'orphan'), n(4, 5, 0), n(5, 4, 0)]);
    expect(out.slice(0, 3).map((x) => x.id)).toEqual([3, 1, 2]);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  test('descendants and cycle detection', () => {
    const nodes = [n(1, null, 0), n(2, 1, 0), n(3, 2, 0), n(4, null, 1)];
    expect(descendantIds(nodes, 1).sort()).toEqual([2, 3]);
    expect(descendantIds(nodes, 4)).toEqual([]);
    expect(wouldCreateCycle(nodes, 1, 3)).toBe(true);
    expect(wouldCreateCycle(nodes, 1, 1)).toBe(true);
    expect(wouldCreateCycle(nodes, 3, 1)).toBe(false);
    expect(wouldCreateCycle(nodes, 2, null)).toBe(false);
  });

  test('positions', () => {
    expect(nextPosition([])).toBe(0);
    expect(nextPosition([{ position: 0 }, { position: 4 }])).toBe(5);
    const sibs = [n(1, null, 0), n(2, null, 1), n(3, null, 2)];
    expect(reorderSiblings(sibs, 3, 0)).toEqual([3, 1, 2]);
    expect(reorderSiblings(sibs, 1, 99)).toEqual([2, 3, 1]);
    expect(reorderSiblings(sibs, 9, 1)).toEqual([1, 9, 2, 3]);
    expect(reorderSiblings(sibs, 2, -5)).toEqual([2, 1, 3]);
  });
});

describe('page edit rules', () => {
  const base: PageFacts = { inProject: true, isAuthor: false, isAdmin: false, isProjectAdmin: false, canEditInProject: false, locked: false };
  const f = (o: Partial<PageFacts>) => ({ ...base, ...o });

  test('project pages need EDIT_ISSUES; locked ones also need to be the author', () => {
    expect(canEditPage(f({}))).toBe(false);
    expect(canEditPage(f({ canEditInProject: true }))).toBe(true);
    expect(canEditPage(f({ canEditInProject: true, locked: true }))).toBe(false);
    expect(canEditPage(f({ canEditInProject: true, locked: true, isAuthor: true }))).toBe(true);
    expect(canEditPage(f({ locked: true, isAuthor: true }))).toBe(false); // author lost the project permission
    expect(canEditPage(f({ locked: true, isProjectAdmin: true }))).toBe(true);
    expect(canEditPage(f({ locked: true, isAdmin: true }))).toBe(true);
  });

  test('workspace pages: author and administrators only', () => {
    const w = (o: Partial<PageFacts>) => f({ inProject: false, ...o });
    expect(canEditPage(w({}))).toBe(false);
    expect(canEditPage(w({ canEditInProject: true }))).toBe(false);
    expect(canEditPage(w({ isAuthor: true }))).toBe(true);
    expect(canEditPage(w({ isAdmin: true }))).toBe(true);
  });

  test('locking and moderation', () => {
    expect(canLockPage(f({ canEditInProject: true }))).toBe(false);
    expect(canLockPage(f({ canEditInProject: true, isAuthor: true }))).toBe(true);
    expect(canLockPage(f({ isProjectAdmin: true }))).toBe(true);
    expect(canLockPage(f({ inProject: false, isAuthor: true }))).toBe(true);
    expect(canModeratePage(f({ isProjectAdmin: true }))).toBe(true);
    expect(canModeratePage(f({ isAuthor: true }))).toBe(false);
    expect(canModeratePage(f({ inProject: false, isProjectAdmin: true }))).toBe(false);
  });
});

describe('summaryFromText', () => {
  test('first meaningful line without markdown markers, capped at 255', () => {
    expect(summaryFromText('- [ ] Fix the login\nmore')).toBe('Fix the login');
    expect(summaryFromText('\n\n## Heading text')).toBe('Heading text');
    expect(summaryFromText('x'.repeat(400))).toHaveLength(255);
  });
});
