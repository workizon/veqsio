import { describe, expect, test } from 'bun:test';
import { mapField, mapForm, slugOf } from './jsm';

describe('JSM field mapping', () => {
  test('summary and description keep their meaning; priority and due date map when they fit', () => {
    expect(mapField({ fieldId: 'summary', name: 'What do you need?', required: true })).toMatchObject({ key: 'summary', type: 'text', required: true, mapping: { target: 'summary' } });
    expect(mapField({ fieldId: 'description', name: 'Details' })).toMatchObject({ key: 'description', type: 'textarea', mapping: { target: 'description' } });
    expect(mapField({ fieldId: 'priority', name: 'Priority', jiraSchema: { type: 'priority' }, validValues: [{ label: 'High' }, { label: 'Low' }] })).toMatchObject({ type: 'select', options: ['High', 'Low'], mapping: { target: 'priority' } });
    expect(mapField({ fieldId: 'duedate', name: 'Due', jiraSchema: { type: 'date' } })).toMatchObject({ type: 'date', mapping: { target: 'dueDate' } });
  });
  test('types follow the Jira schema; custom field ids become safe keys', () => {
    expect(mapField({ fieldId: 'customfield_10010', name: 'Count', jiraSchema: { type: 'number' } })).toMatchObject({ key: 'customfield_10010', type: 'number' });
    expect(mapField({ fieldId: 'customfield_10011', name: 'Env', jiraSchema: { type: 'option' }, validValues: [{ label: 'Prod' }, { value: 'Dev' }] })).toMatchObject({ type: 'select', options: ['Prod', 'Dev'] });
    expect(mapField({ fieldId: 'customfield_10012', name: 'Tags', jiraSchema: { type: 'array', items: 'option' }, validValues: [{ label: 'a' }] })).toMatchObject({ type: 'multiselect' });
    expect(mapField({ fieldId: 'customfield_10013', name: 'Who', jiraSchema: { type: 'user' } })).toMatchObject({ type: 'user' });
    expect(mapField({ fieldId: 'customfield_10014', name: 'Notes', jiraSchema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } })).toMatchObject({ type: 'textarea' });
  });
  test('fields Veqsio sets itself or that are hidden are skipped', () => {
    for (const id of ['reporter', 'attachment', 'issuetype', 'components', 'labels']) expect(mapField({ fieldId: id, name: id })).toBeNull();
    expect(mapField({ fieldId: 'customfield_1', name: 'Hidden', visible: false })).toBeNull();
    expect(mapField(null as never)).toBeNull();
  });
});

describe('JSM form assembly', () => {
  test('a valid form passes the Veqsio form validator unchanged', () => {
    const r = mapForm([{ fieldId: 'summary', name: 'S', required: true }, { fieldId: 'description', name: 'D' }, { fieldId: 'customfield_1', name: 'Pick', jiraSchema: { type: 'option' }, validValues: [{ label: 'x' }] }], 'Get IT help');
    expect(r.defs.map((d) => d.key)).toEqual(['summary', 'description', 'customfield_1']);
    expect(r.warnings).toEqual([]);
  });
  test('duplicate keys and choice fields without options are dropped with a warning', () => {
    const r = mapForm([{ fieldId: 'customfield_1', name: 'A' }, { fieldId: 'customfield_1', name: 'A again' }, { fieldId: 'customfield_2', name: 'Empty choice', jiraSchema: { type: 'option' } }], 'T');
    expect(r.defs.map((d) => d.key)).toEqual(['customfield_1', 'customfield_2']);
    expect(r.warnings.some((w) => w.includes('A again'))).toBe(true);
  });
  test('slugs are url safe', () => {
    expect(slugOf('IT Help Desk!')).toBe('it-help-desk');
    expect(slugOf('***')).toBe('desk');
    expect(/^[a-z0-9][a-z0-9-]{1,98}$/.test(slugOf('Ünïcode  Name'))).toBe(true);
  });
});
