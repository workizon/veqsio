import { describe, it, expect } from 'bun:test';
import { computeTimeInStatus, averageTimeInStatus, formatDuration } from './time-in-status';
import { buildDescriptionVersions } from './description';
import { appendDroppedFields, fieldCarriedBy, stringifyFieldValue } from './change-type';
import { diffItemLists, diffTransition, describeItem } from '../workflow/governance';

const H = 3_600_000;
const t0 = new Date('2026-01-01T00:00:00Z');
const at = (h: number) => new Date(t0.getTime() + h * H);
const cat = (s: string) => (s === 'Done' ? 'done' : s === 'In Progress' ? 'in_progress' : 'todo');

describe('time in status', () => {
  it('builds segments from the status history', () => {
    const r = computeTimeInStatus({
      createdAt: t0, creatorId: 1, currentStatus: 'Done', now: at(100), categoryOf: cat,
      changes: [
        { at: at(10), from: 'To Do', to: 'In Progress', by: 2 },
        { at: at(30), from: 'In Progress', to: 'To Do', by: 3 },
        { at: at(40), from: 'To Do', to: 'In Progress', by: 2 },
        { at: at(60), from: 'In Progress', to: 'Done', by: null },
      ],
    });
    expect(r.segments.map((s) => s.status)).toEqual(['To Do', 'In Progress', 'To Do', 'In Progress', 'Done']);
    expect(r.segments[0].movedBy).toBe(1);
    expect(r.segments[1].movedBy).toBe(2);
    expect(r.segments[4].leftAt).toBeNull();
    expect(r.segments[4].durationMs).toBe(40 * H);
    const ip = r.byStatus.find((s) => s.status === 'In Progress')!;
    expect(ip.durationMs).toBe(40 * H);
    expect(ip.visits).toBe(2);
    expect(r.byCategory.find((c) => c.category === 'todo')!.durationMs).toBe(20 * H);
    expect(r.totalMs).toBe(100 * H);
  });

  it('an issue that never moved spent all its time in the current status', () => {
    const r = computeTimeInStatus({ createdAt: t0, creatorId: 1, currentStatus: 'To Do', now: at(5), changes: [] });
    expect(r.segments).toHaveLength(1);
    expect(r.totalMs).toBe(5 * H);
  });

  it('averages per stay over many issues', () => {
    const a = computeTimeInStatus({ createdAt: t0, creatorId: 1, currentStatus: 'Done', now: at(50), categoryOf: cat, changes: [{ at: at(10), from: 'To Do', to: 'Done', by: 1 }] });
    const b = computeTimeInStatus({ createdAt: t0, creatorId: 1, currentStatus: 'Done', now: at(50), categoryOf: cat, changes: [{ at: at(30), from: 'To Do', to: 'Done', by: 1 }] });
    const rows = averageTimeInStatus([a, b]);
    const todo = rows.find((r) => r.status === 'To Do')!;
    expect(todo.issues).toBe(2);
    expect(todo.avgMs).toBe(20 * H);
    expect(rows[0].status).toBe('Done'); // (40h + 20h) / 2 = 30h, longest first
  });

  it('formats durations', () => {
    expect(formatDuration(1000)).toBe('<1m');
    expect(formatDuration(45 * 60_000)).toBe('45m');
    expect(formatDuration(26 * H)).toBe('1d 2h');
    expect(formatDuration(2 * H)).toBe('2h');
  });
});

describe('description versions', () => {
  it('derives versions from history rows, original first', () => {
    const v = buildDescriptionVersions({
      createdAt: t0, creatorId: 1,
      changes: [
        { id: 2, at: at(2), from: 'b', to: 'c', by: 3 },
        { id: 1, at: at(1), from: 'a', to: 'b', by: 2 },
      ],
    });
    expect(v.map((x) => x.text)).toEqual(['a', 'b', 'c']);
    expect(v.map((x) => x.version)).toEqual([1, 2, 3]);
    expect(v[2].current).toBe(true);
    expect(v[0].authorId).toBe(1);
  });
  it('no changes means no versions', () => {
    expect(buildDescriptionVersions({ createdAt: t0, creatorId: 1, changes: [] })).toEqual([]);
  });
  it('treats null as an empty text', () => {
    const v = buildDescriptionVersions({ createdAt: t0, creatorId: 1, changes: [{ id: 1, at: at(1), from: null, to: 'x', by: 1 }] });
    expect(v[0].text).toBe('');
  });
});

describe('type change helpers', () => {
  it('a context restricts a field, a hidden configuration item removes it', () => {
    const ctx = [{ customFieldId: 1, projectId: 5, issueTypeId: 7 }];
    expect(fieldCarriedBy({ id: 1 }, ctx, [], 5, 7)).toBe(true);
    expect(fieldCarriedBy({ id: 1 }, ctx, [], 5, 8)).toBe(false);
    expect(fieldCarriedBy({ id: 1 }, ctx, [], 6, 7)).toBe(false);
    expect(fieldCarriedBy({ id: 2 }, ctx, [], 6, 8)).toBe(true); // no context: global
    expect(fieldCarriedBy({ id: 2 }, [], [{ fieldId: 2, isCustomField: true, isVisible: false }], 1, 1)).toBe(false);
    expect(fieldCarriedBy({ id: 2 }, [], [{ fieldId: 2, isCustomField: false, isVisible: false }], 1, 1)).toBe(true);
  });
  it('appends a labelled warning block to the description', () => {
    const out = appendDroppedFields('Body', [{ id: 'customfield_1', name: 'Severity', value: 'High' }], 'Bug', 'Task', new Date('2026-11-12T00:00:00Z'))!;
    expect(out.startsWith('Body\n\n---')).toBe(true);
    expect(out).toContain('Warning: fields removed by the type change Bug -> Task (2026-11-12)');
    expect(out).toContain('- **Severity:** High');
    expect(appendDroppedFields('Body', [], 'a', 'b')).toBe('Body');
    expect(appendDroppedFields(null, [{ id: 'x', name: 'N', value: 'v' }], 'a', 'b')!.startsWith('---')).toBe(true);
  });
  it('stringifies values', () => {
    expect(stringifyFieldValue(null)).toBe('');
    expect(stringifyFieldValue(3)).toBe('3');
    expect(stringifyFieldValue(['a'])).toBe('["a"]');
  });
});

describe('workflow change descriptions', () => {
  it('lists added and removed conditions', () => {
    const e = diffItemLists('condition', 'Condition', 'Start', [{ type: 'a' }, { type: 'b', role: 1 }], [{ type: 'b', role: 1 }, { type: 'c' }]);
    expect(e.map((x) => `${x.action}:${x.summary}`)).toEqual([
      'created:Condition added on transition "Start": c',
      'deleted:Condition removed from transition "Start": a',
    ]);
    expect(describeItem({ type: 'role', role: 3 })).toBe('role (role=3)');
  });
  it('describes renames and retargeting', () => {
    const base = { name: 'Go', fromStatusId: 1, toStatusId: 2, screenId: null, conditions: [], validators: [], postFunctions: [] };
    const names = (id: number | null) => (id === null ? 'Any' : `S${id}`);
    const e = diffTransition(base, { ...base, name: 'Go on', toStatusId: 3 }, names);
    expect(e).toHaveLength(1);
    expect(e[0].summary).toContain('renamed from "Go"');
    expect(e[0].summary).toContain('target S2 -> S3');
    expect(diffTransition(base, base, names)).toEqual([]);
  });
});
