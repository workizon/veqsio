import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_CONFIG, cellText, clearLastUsed, configEquals, issuesOf, loadLastUsed, moveColumn, nextSort, saveLastUsed,
  timelineItems, toggleColumn, withGrouping, type KeyValueStore,
} from '../lib/views'

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }
}

describe('views helpers', () => {
  test('sort cycles asc, desc, none and ignores unsortable columns', () => {
    let s = nextSort([], 'summary')
    expect(s).toEqual([{ field: 'summary', direction: 'asc' }])
    s = nextSort(s, 'summary')
    expect(s).toEqual([{ field: 'summary', direction: 'desc' }])
    expect(nextSort(s, 'summary')).toEqual([])
    expect(nextSort(s, 'status')).toEqual([{ field: 'status', direction: 'asc' }])
    expect(nextSort(s, 'labels')).toBe(s)
  })

  test('columns: toggle keeps at least one, move stays in range', () => {
    expect(toggleColumn(['key'], 'key')).toEqual(['key'])
    expect(toggleColumn(['key', 'status'], 'status')).toEqual(['key'])
    expect(toggleColumn(['key'], 'labels')).toEqual(['key', 'labels'])
    expect(moveColumn(['key', 'summary', 'status'], 'status', -1)).toEqual(['key', 'status', 'summary'])
    expect(moveColumn(['key', 'summary'], 'key', -1)).toEqual(['key', 'summary'])
    expect(moveColumn(['key', 'summary'], 'summary', 1)).toEqual(['key', 'summary'])
  })

  test('grouping resets an impossible sub-group', () => {
    expect(withGrouping(DEFAULT_CONFIG, { subGroupBy: 'label' }).subGroupBy).toBe('none')
    expect(withGrouping(DEFAULT_CONFIG, { groupBy: 'status', subGroupBy: 'assignee' })).toMatchObject({ groupBy: 'status', subGroupBy: 'assignee' })
    const c = withGrouping({ ...DEFAULT_CONFIG, groupBy: 'status', subGroupBy: 'assignee' }, { groupBy: 'assignee' })
    expect(c.subGroupBy).toBe('none')
    expect(withGrouping({ ...DEFAULT_CONFIG, groupBy: 'status', subGroupBy: 'assignee' }, { groupBy: 'none' }).subGroupBy).toBe('none')
  })

  test('config equality ignores jql whitespace', () => {
    expect(configEquals(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, query: { jql: '  ' } })).toBe(true)
    expect(configEquals(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, layout: 'table' })).toBe(false)
    expect(configEquals(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, columns: ['key'] })).toBe(false)
  })

  test('last used settings round trip per view and survive garbage', () => {
    const store = memory()
    expect(loadLastUsed(store, '1')).toBeNull()
    saveLastUsed(store, '1', { ...DEFAULT_CONFIG, layout: 'board', groupBy: 'status', showEmptyGroups: true })
    expect(loadLastUsed(store, '1')).toMatchObject({ layout: 'board', groupBy: 'status', showEmptyGroups: true })
    expect(loadLastUsed(store, '2')).toBeNull()
    store.setItem('veqsio-view-last:3', '{nope')
    expect(loadLastUsed(store, '3')).toBeNull()
    store.setItem('veqsio-view-last:4', JSON.stringify({ layout: 'table', columns: ['bogus', 'key'], groupBy: 'x', sort: [{ field: 'nope', direction: 'asc' }, { field: 'key', direction: 'desc' }] }))
    expect(loadLastUsed(store, '4')).toMatchObject({ layout: 'table', columns: ['key'], groupBy: 'none', sort: [{ field: 'key', direction: 'desc' }] })
    store.setItem('veqsio-view-last:5', JSON.stringify({ layout: 'nope', columns: ['key'] }))
    expect(loadLastUsed(store, '5')).toBeNull()
    clearLastUsed(store, '1')
    expect(loadLastUsed(store, '1')).toBeNull()
    expect(loadLastUsed(null, '1')).toBeNull()
    expect(() => saveLastUsed(null, '1', DEFAULT_CONFIG)).not.toThrow()
  })

  test('cell text and group id resolution', () => {
    const i = { id: 1, key: 'T-1', fields: { summary: 'S', assignee: null, labels: ['a', 'b'], components: [{ name: 'API' }], created: '2026-01-02T10:00:00Z', storyPoints: 0 } }
    expect(cellText(i, 'key')).toBe('T-1')
    expect(cellText(i, 'assignee')).toBe('Unassigned')
    expect(cellText(i, 'labels')).toBe('a, b')
    expect(cellText(i, 'components')).toBe('API')
    expect(cellText(i, 'created')).toBe('2026-01-02')
    expect(cellText(i, 'storyPoints')).toBe('0')
    expect(cellText(i, 'priority')).toBe('')
    expect(issuesOf([2, 1, 9], new Map([[1, i], [2, { ...i, id: 2 }]])).map((x) => x.id)).toEqual([2, 1])
  })

  test('timeline items use start date, else due date; the rest is unscheduled', () => {
    const mk = (id: number, f: any) => ({ id, key: `T-${id}`, fields: { summary: 's', ...f } })
    const { items, unscheduled } = timelineItems([
      mk(1, { startdate: '2026-01-01', duedate: '2026-01-10' }), mk(2, { duedate: '2026-02-01' }),
      mk(3, {}), mk(4, { startdate: '2026-03-01', duedate: '2026-02-01' }),
    ])
    expect(items.map((x) => [x.key, x.start, x.end])).toEqual([['T-1', '2026-01-01', '2026-01-10'], ['T-2', '2026-02-01', '2026-02-01'], ['T-4', '2026-03-01', null]])
    expect(unscheduled.map((x) => x.key)).toEqual(['T-3'])
  })
})
