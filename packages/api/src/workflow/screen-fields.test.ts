import { describe, test, expect } from 'bun:test';
import { parseScreenInput, customScreenType, SYSTEM_SCREEN_FIELDS, type ScreenFieldDef } from './screen-fields';

const sys = (key: string, required = false): ScreenFieldDef => {
  const f = SYSTEM_SCREEN_FIELDS.find((x) => x.key === key)!;
  return { key, name: f.name, type: f.type, custom: false, required };
};
const custom = (id: number, type: ScreenFieldDef['type'], extra: Partial<ScreenFieldDef> = {}): ScreenFieldDef => ({ key: `customfield_${id}`, name: `CF${id}`, type, custom: true, customId: id, required: false, ...extra });
const none = () => false;

describe('parseScreenInput', () => {
  test('required fields that are missing, empty or null are reported, with the field name', () => {
    const defs = [sys('assignee', true), sys('labels', true), sys('duedate', true), sys('comment', true)];
    const r = parseScreenInput(defs, { labels: [], duedate: '', comment: '   ' }, none);
    expect(r.errors).toEqual({ assignee: 'Assignee is required', labels: 'Labels is required', duedate: 'Due date is required', comment: 'Comment is required' });
  });
  test('a required field left out is fine when the issue already has a value, but clearing it is not', () => {
    const defs = [sys('assignee', true)];
    expect(parseScreenInput(defs, {}, (k) => k === 'assignee').errors).toEqual({});
    expect(parseScreenInput(defs, { assignee: null }, (k) => k === 'assignee').errors.assignee).toBeDefined();
  });
  test('Jira shaped values become an issue update', () => {
    const defs = [sys('assignee'), sys('priority'), sys('labels'), sys('fixVersions'), sys('components'), sys('duedate'), sys('storyPoints'), sys('environment'), sys('comment')];
    const r = parseScreenInput(defs, {
      assignee: { id: '7' }, priority: { id: 2 }, labels: ['a', ' b ', 'a'], fixVersions: [{ id: 1 }, 2], components: [{ id: '3' }],
      duedate: '2026-02-28', storyPoints: '3,5', environment: 'prod', comment: ' hi ',
    }, none);
    expect(r.errors).toEqual({});
    expect(r.update).toEqual({ assigneeId: 7, priorityId: 2, labels: ['a', 'b'], fixVersions: [1, 2], components: [3], dueDate: '2026-02-28', storyPoints: 3.5, environment: 'prod' });
    expect(r.comment).toBe('hi');
    expect(r.refs).toEqual({ assigneeId: 7, priorityId: 2, componentIds: [3], versionIds: [1, 2] });
  });
  test('clearing optional fields', () => {
    const r = parseScreenInput([sys('assignee'), sys('duedate'), sys('storyPoints'), sys('labels')], { assignee: null, duedate: null, storyPoints: '', labels: [] }, none);
    expect(r.errors).toEqual({});
    expect(r.update).toEqual({ assigneeId: null, dueDate: null, storyPoints: null, labels: [] });
  });
  test('invalid values give one message per field', () => {
    const r = parseScreenInput([sys('assignee'), sys('priority'), sys('labels'), sys('fixVersions'), sys('duedate'), sys('storyPoints'), sys('environment'), sys('comment')], {
      assignee: 'abc', priority: { id: 'x' }, labels: ['has space'], fixVersions: 'nope', duedate: '2026-02-30', storyPoints: 1001, environment: 5, comment: 5,
    }, none);
    expect(Object.keys(r.errors).sort()).toEqual(['assignee', 'comment', 'duedate', 'environment', 'fixVersions', 'labels', 'priority', 'storyPoints']);
    expect(r.update).toEqual({});
  });
  test('priority cannot be cleared', () => {
    expect(parseScreenInput([sys('priority')], { priority: null }, none).errors.priority).toContain('cannot be cleared');
  });
  test('custom fields: number, date, select with options, boolean, text length', () => {
    const defs = [custom(1, 'number'), custom(2, 'date'), custom(3, 'select', { options: ['Red', 'Blue'] }), custom(4, 'boolean'), custom(5, 'string')];
    const ok = parseScreenInput(defs, { customfield_1: '4.5', customfield_2: '2026-05-01', customfield_3: 'Red', customfield_4: true, customfield_5: 'x' }, none);
    expect(ok.errors).toEqual({});
    expect(ok.update.customFields).toEqual([
      { fieldId: 1, value: 4.5 }, { fieldId: 2, value: '2026-05-01' }, { fieldId: 3, value: 'Red' }, { fieldId: 4, value: true }, { fieldId: 5, value: 'x' },
    ]);
    const bad = parseScreenInput(defs, { customfield_1: 'abc', customfield_2: 'not a date', customfield_3: 'Green', customfield_5: 'y'.repeat(501) }, none);
    expect(Object.keys(bad.errors).sort()).toEqual(['customfield_1', 'customfield_2', 'customfield_3', 'customfield_5']);
    expect(bad.update.customFields).toBeUndefined();
  });
  test('a custom number is not confused with story points (same type name, different field kind)', () => {
    const r = parseScreenInput([custom(1, 'number')], { customfield_1: 5000 }, none);
    expect(r.errors).toEqual({});
    expect(r.update.storyPoints).toBeUndefined();
  });
  test('required custom field: empty value fails, clearing writes null otherwise', () => {
    expect(parseScreenInput([custom(1, 'string', { required: true })], { customfield_1: '' }, none).errors.customfield_1).toBeDefined();
    expect(parseScreenInput([custom(1, 'string')], { customfield_1: '' }, none).update.customFields).toEqual([{ fieldId: 1, value: null }]);
  });
  test('resolution is left to the transition but its required flag is checked', () => {
    expect(parseScreenInput([sys('resolution', true)], { resolution: '' }, none).errors.resolution).toBeDefined();
    expect(parseScreenInput([sys('resolution', true)], { resolution: { id: 3 } }, none).errors).toEqual({});
    expect(parseScreenInput([sys('resolution', true)], {}, (k) => k === 'resolution').errors).toEqual({});
  });
  test('custom field type mapping', () => {
    expect(customScreenType('radio')).toBe('select');
    expect(customScreenType('checkbox')).toBe('boolean');
    expect(customScreenType('userpicker')).toBe('string');
    expect(customScreenType('number')).toBe('number');
  });
});
