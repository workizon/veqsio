import { describe, expect, test } from 'bun:test';
import { inflateRawSync } from 'node:zlib';
import {
  BUILTIN_VIEWS, buildFilterJql, defaultConfig, describeQuery, normalizeConfig, parseConfig, tidyConfig,
} from './config';
import { groupIssues, type GroupableIssue } from './grouping';
import { columnValue } from './columns';
import { csvField, csvLine, exportFileName, neutralizeFormula, safeCell } from './export';
import { buildXlsx, columnLetter, crc32, sheetName, xmlEscape } from './xlsx';
import { sortTerms, statusOrder } from './executor';
import { validateJql } from '../jql/autocomplete';

const issue = (id: number, f: Record<string, any>): GroupableIssue => ({ id, key: `T-${id}`, fields: f });
const st = (id: number, name: string, category = 'new') => ({ id, name, category });

describe('view config', () => {
  test('defaults and strict validation', () => {
    const c = defaultConfig();
    expect(c.layout).toBe('list');
    expect(c.columns.length).toBeGreaterThan(3);
    expect(parseConfig({ layout: 'grid' }).ok).toBe(false);
    expect(parseConfig({ bogus: 1 }).ok).toBe(false);
    expect(parseConfig({ columns: ['nope'] }).ok).toBe(false);
    expect(parseConfig({ sort: [{ field: 'key', direction: 'up' }] }).ok).toBe(false);
    expect(parseConfig({ columns: [] }).ok).toBe(false);
    expect(parseConfig({ query: { jql: 'x'.repeat(6000) } }).ok).toBe(false);
  });

  test('tidy removes duplicate columns, duplicate sort fields and a sub-group equal to the group', () => {
    const r = parseConfig({
      columns: ['key', 'key', 'status'], sort: [{ field: 'key', direction: 'asc' }, { field: 'key', direction: 'desc' }],
      groupBy: 'status', subGroupBy: 'status',
    });
    expect(r.ok && r.config.columns).toEqual(['key', 'status']);
    expect(r.ok && r.config.sort).toEqual([{ field: 'key', direction: 'asc' }]);
    expect(r.ok && r.config.subGroupBy).toBe('none');
    expect(tidyConfig({ ...defaultConfig(), groupBy: 'none', subGroupBy: 'label' }).subGroupBy).toBe('none');
  });

  test('stored garbage never throws and falls back per field', () => {
    expect(normalizeConfig(null).layout).toBe('list');
    expect(normalizeConfig('{not json').layout).toBe('list');
    expect(normalizeConfig([1]).layout).toBe('list');
    const c = normalizeConfig({ layout: 'board', groupBy: 'weird', columns: ['key'], extra: true });
    expect(c.layout).toBe('board');
    expect(c.groupBy).toBe('none');
    expect(c.columns).toEqual(['key']);
  });

  test('simple filters compile to quoted JQL that the validator accepts', () => {
    const jql = buildFilterJql({
      projects: ['TEST'], statuses: ['In Progress', 'Done'], assignee: 'me', reporter: 'alice', text: 'login bug', resolution: 'open',
    });
    expect(jql).toBe('project in ("TEST") AND status in ("In Progress", "Done") AND assignee = currentUser() AND reporter = "alice" AND text ~ "login bug" AND resolution is EMPTY');
    expect(validateJql(jql).valid).toBe(true);
    expect(buildFilterJql({ assignee: 'unassigned' })).toBe('assignee is EMPTY');
    expect(buildFilterJql(undefined)).toBe('');
    expect(buildFilterJql({})).toBe('');
  });

  test('a filter value cannot break out of its quotes', () => {
    const jql = buildFilterJql({ statuses: ['x" OR project = SECRET OR status = "y'] });
    expect(jql).toBe('status in ("x  OR project = SECRET OR status =  y")');
    expect(jql.match(/"/g)!.length).toBe(2);
    expect(buildFilterJql({ text: 'a\\"b' })).not.toContain('\\');
  });

  test('describeQuery and built-in views', () => {
    expect(describeQuery({ jql: '' })).toBe('All issues');
    expect(describeQuery({ jql: 'a = b', filters: { assignee: 'me' } })).toBe('a = b AND assignee = currentUser()');
    expect(BUILTIN_VIEWS.map((b) => b.key)).toEqual(['all-work', 'assigned-to-me', 'created-by-me', 'recently-updated']);
    for (const b of BUILTIN_VIEWS) {
      expect(b.id).toBe(`builtin:${b.key}`);
      if (b.config.query.jql) expect(validateJql(b.config.query.jql).valid).toBe(true);
    }
  });
});

describe('group by bucketing', () => {
  const issues = [
    issue(1, { status: st(10, 'Done', 'done'), assignee: { id: 1, displayName: 'Zed' }, priority: { id: 2, name: 'High' }, issuetype: { id: 1, name: 'Bug' }, labels: ['b', 'a'] }),
    issue(2, { status: st(11, 'To Do'), assignee: null, priority: null, issuetype: { id: 2, name: 'Task' }, labels: [] }),
    issue(3, { status: st(11, 'To Do'), assignee: { id: 2, displayName: 'Amy' }, priority: { id: 2, name: 'High' }, issuetype: { id: 1, name: 'Bug' }, labels: ['a'], sprint: { id: 5, name: 'S5', state: 'active' } }),
    issue(4, { status: st(12, 'In Progress', 'indeterminate'), assignee: { id: 1, displayName: 'Zed' }, issuetype: { id: 1, name: 'Bug' }, labels: undefined }),
  ];

  test('none gives one group with everything', () => {
    const g = groupIssues(issues, 'none', 'status');
    expect(g).toHaveLength(1);
    expect(g[0].issueIds).toEqual([1, 2, 3, 4]);
    expect(g[0].subGroups).toBeUndefined();
  });

  test('status groups are ordered by category, then name; counts match', () => {
    const g = groupIssues(issues, 'status', 'none');
    expect(g.map((x) => x.label)).toEqual(['To Do', 'In Progress', 'Done']);
    expect(g.map((x) => x.count)).toEqual([2, 1, 1]);
  });

  test('assignee puts Unassigned last; priority likewise', () => {
    expect(groupIssues(issues, 'assignee', 'none').map((x) => x.label)).toEqual(['Zed', 'Amy', 'Unassigned'].sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b))));
    const p = groupIssues(issues, 'priority', 'none');
    expect(p[p.length - 1].label).toBe('No priority');
    expect(p[p.length - 1].issueIds).toEqual([2, 4]);
  });

  test('labels: an issue appears in every label bucket, none under No label', () => {
    const g = groupIssues(issues, 'label', 'none');
    const by = Object.fromEntries(g.map((x) => [x.label, x.issueIds]));
    expect(by.a).toEqual([1, 3]);
    expect(by.b).toEqual([1]);
    expect(by['No label']).toEqual([2, 4]);
    expect(g[g.length - 1].label).toBe('No label');
  });

  test('sprint groups: active first, no sprint last', () => {
    const g = groupIssues(issues, 'sprint', 'none');
    expect(g.map((x) => x.label)).toEqual(['S5', 'No sprint']);
  });

  test('sub-groups nest and ignore a sub-group equal to the group', () => {
    const g = groupIssues(issues, 'status', 'assignee');
    const todo = g.find((x) => x.label === 'To Do')!;
    expect(todo.subGroups!.map((s) => [s.label, s.issueIds])).toEqual([['Amy', [3]], ['Unassigned', [2]]]);
    expect(groupIssues(issues, 'status', 'status')[0].subGroups).toBeUndefined();
  });

  test('show empty groups adds universe members only when asked, and the universe orders known values', () => {
    const universe = {
      status: [
        { key: 'status:11', label: 'To Do', order: 5 }, { key: 'status:12', label: 'In Progress', order: 1 },
        { key: 'status:99', label: 'Blocked', order: 3 }, { key: 'status:10', label: 'Done', order: 9 },
      ],
    };
    expect(groupIssues(issues, 'status', 'none', { universe }).map((x) => x.label)).toEqual(['In Progress', 'To Do', 'Done']);
    const g = groupIssues(issues, 'status', 'none', { showEmpty: true, universe });
    expect(g.map((x) => x.label)).toEqual(['In Progress', 'Blocked', 'To Do', 'Done']);
    expect(g[1]).toMatchObject({ count: 0, issueIds: [] });
  });

  test('empty sub-groups appear with showEmpty', () => {
    const g = groupIssues(issues, 'assignee', 'type', { showEmpty: true });
    const amy = g.find((x) => x.label === 'Amy')!;
    expect(amy.subGroups!.map((s) => [s.label, s.count])).toEqual([['Bug', 1], ['Task', 0]]);
    const noEmpty = groupIssues(issues, 'assignee', 'type').find((x) => x.label === 'Amy')!;
    expect(noEmpty.subGroups!.map((s) => s.label)).toEqual(['Bug']);
  });

  test('empty input', () => {
    expect(groupIssues([], 'status', 'none')).toEqual([]);
    expect(groupIssues([], 'none', 'none')).toEqual([]);
  });
});

describe('sort', () => {
  test('sort terms map every sort field and always end with the id tie-breaker', () => {
    const fields = ['key', 'summary', 'type', 'status', 'priority', 'assignee', 'reporter', 'project', 'storyPoints', 'created', 'updated', 'resolved', 'duedate', 'startdate'] as const;
    for (const field of fields) {
      const asc = sortTerms([{ field, direction: 'asc' }]);
      const desc = sortTerms([{ field, direction: 'desc' }]);
      expect(asc.length).toBeGreaterThanOrEqual(2);
      expect(asc.length).toBe(desc.length);
    }
    expect(sortTerms([])).toHaveLength(1);
    expect(sortTerms([{ field: 'key', direction: 'asc' }, { field: 'created', direction: 'desc' }]).length).toBe(5);
  });

  test('status order: category first, then sort order', () => {
    expect(statusOrder('new', 5, 1)).toBeLessThan(statusOrder('indeterminate', 0, 2));
    expect(statusOrder('indeterminate', 9, 2)).toBeLessThan(statusOrder('done', 0, 3));
    expect(statusOrder(null, null, 7)).toBe(1007);
  });
});

describe('column values', () => {
  const i = issue(1, {
    summary: 'S', status: st(1, 'Open'), issuetype: { id: 1, name: 'Bug' }, priority: null, assignee: { id: 1, displayName: 'Amy' },
    labels: ['x', 'y'], components: [{ id: 1, name: 'API' }], storyPoints: 3, duedate: '2026-01-02', project: { key: 'T' }, sprint: { id: 1, name: 'S1' },
  });
  test('extracts scalars, lists and nulls', () => {
    expect(columnValue(i, 'key')).toBe('T-1');
    expect(columnValue(i, 'type')).toBe('Bug');
    expect(columnValue(i, 'priority')).toBeNull();
    expect(columnValue(i, 'labels')).toEqual(['x', 'y']);
    expect(columnValue(i, 'components')).toEqual(['API']);
    expect(columnValue(i, 'storyPoints')).toBe(3);
    expect(columnValue(i, 'sprint')).toBe('S1');
    expect(columnValue(i, 'resolved')).toBeNull();
  });
});

describe('CSV / cell escaping', () => {
  test('formula injection is neutralised with an apostrophe', () => {
    for (const s of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) expect(neutralizeFormula(s)).toBe(`'${s}`);
    expect(neutralizeFormula('safe =x')).toBe('safe =x');
    expect(csvField('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvField('@a')).toBe("'@a");
  });

  test('numbers are untouched, including negative ones; null is empty', () => {
    expect(csvField(-5)).toBe('-5');
    expect(csvField(0)).toBe('0');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(safeCell(Number.NaN)).toBe('NaN');
  });

  test('quotes separators, quotes and line breaks; lists are joined', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('l1\nl2')).toBe('"l1\nl2"');
    expect(csvField(['a', 'b'])).toBe('"a, b"');
    expect(csvLine(['k', 'x,y', 3])).toBe('k,"x,y",3\r\n');
  });

  test('control characters invalid in XML/spreadsheets are stripped', () => {
    expect(safeCell('a\u0000b\u0007c')).toBe('abc');
  });

  test('file names are safe', () => {
    expect(exportFileName('My "view"/../x', 'csv', new Date('2026-02-03T00:00:00Z'))).toBe('My-view-x-2026-02-03.csv');
    expect(exportFileName('###', 'json', new Date('2026-02-03T00:00:00Z'))).toBe('export-2026-02-03.json');
    expect(exportFileName('Ünï', 'csv', new Date('2026-02-03T00:00:00Z'))).toMatch(/^[A-Za-z0-9_-]+-2026-02-03\.csv$/);
  });
});

/** Minimal ZIP reader for the tests: verifies signatures, sizes and CRCs. */
function unzip(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = buf.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    expect(dv.getUint32(off, true)).toBe(0x04034b50);
    const lnlen = dv.getUint16(off + 26, true);
    const lxlen = dv.getUint16(off + 28, true);
    const start = off + 30 + lnlen + lxlen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : new Uint8Array(raw);
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nlen;
  }
  return out;
}

describe('XLSX writer', () => {
  const headers = ['Key', 'Summary', 'Points'];
  const rows = [
    ['T-1', 'Fix <login> & "logout"', 3],
    ['T-2', '=cmd|calc', -1.5],
    ['T-3', null, ['a', 'b']],
  ];
  const files = unzip(buildXlsx('My: view/1', headers, rows as any));
  const text = (n: string) => new TextDecoder().decode(files.get(n)!);

  test('is a valid zip with the required parts and correct CRCs', () => {
    expect([...files.keys()].sort()).toEqual([
      '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
    ]);
    for (const [name, data] of files) if (name.endsWith('.xml') || name.endsWith('.rels')) expect(text(name).startsWith('<?xml')).toBe(true);
    expect(text('xl/workbook.xml')).toContain('<sheet name="My  view 1"');
  });

  test('sheet content: header, escaped strings, numbers, neutralised formulas, joined lists', () => {
    const sheet = text('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<row r="1"><c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Key</t></is></c>');
    expect(sheet).toContain('Fix &lt;login&gt; &amp; &quot;logout&quot;');
    expect(sheet).toContain('<c r="C2"><v>3</v></c>');
    expect(sheet).toContain('<c r="C3"><v>-1.5</v></c>');
    expect(sheet).toContain("&gt;")
    expect(sheet).toContain("<t xml:space=\"preserve\">'=cmd|calc</t>");
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('<c r="C4" t="inlineStr"><is><t xml:space="preserve">a, b</t></is></c>');
    expect(sheet).not.toContain('r="B4"'); // null cell omitted
  });

  test('helpers', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    expect(xmlEscape(`<&>"`)).toBe('&lt;&amp;&gt;&quot;');
    expect(sheetName('')).toBe('Sheet1');
    expect(sheetName('x'.repeat(50)).length).toBe(31);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  test('empty sheet and many rows still produce a valid archive', () => {
    expect(unzip(buildXlsx('E', ['A'], [])).has('xl/worksheets/sheet1.xml')).toBe(true);
    const big = Array.from({ length: 5000 }, (_, i) => [`T-${i}`, `row ${i}`]);
    const f = unzip(buildXlsx('Big', ['k', 'v'], big));
    expect(new TextDecoder().decode(f.get('xl/worksheets/sheet1.xml')!)).toContain('r="A5001"');
  });
});
