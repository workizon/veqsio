import { describe, test, expect } from 'bun:test'
import { findReverseTransition, assigneeRestorePatch, buildBulkSnapshots, changedSnapshots, labelsRemovalMessage } from '../lib/undo-helpers'

const t = (id: number, name: string, to: string, extra: Record<string, unknown> = {}) => ({
  id, name, to: { id: id * 10, name: to, statusCategory: { key: 'in_progress', normalizedKey: 'in_progress' } }, ...extra,
})

describe('findReverseTransition', () => {
  const movedTo = { name: 'In Progress', statusCategory: { key: 'in_progress', normalizedKey: 'in_progress' } }
  test('picks a plain transition back to the previous status', () => {
    const list = [t(1, 'Stop', 'To Do'), t(2, 'Resolve', 'Done')]
    expect(findReverseTransition(list, 'To Do', movedTo)?.id).toBe(1)
  })
  test('refuses when the way back needs input, a screen, a resolution or a comment', () => {
    for (const extra of [{ requiresInput: true }, { hasScreen: true }, { requiresResolution: true }, { requiresComment: true }]) {
      expect(findReverseTransition([t(1, 'Back', 'To Do', extra)], 'To Do', movedTo)).toBeNull()
    }
  })
  test('refuses when the workflow has no way back', () => {
    expect(findReverseTransition([t(2, 'Resolve', 'Done')], 'To Do', movedTo)).toBeNull()
    expect(findReverseTransition([], 'To Do', movedTo)).toBeNull()
  })
  test('refuses when the move resolved the issue (resolution and labels would not be restored)', () => {
    const done = { name: 'Done', statusCategory: { key: 'done', normalizedKey: 'done' } }
    expect(findReverseTransition([t(1, 'Reopen', 'To Do')], 'To Do', done)).toBeNull()
  })
})

describe('restore helpers', () => {
  test('assignee restore patch', () => {
    expect(assigneeRestorePatch({ id: 4 })).toEqual({ assignee: { id: 4 } })
    expect(assigneeRestorePatch(null)).toEqual({ assignee: null })
  })
  test('message', () => {
    expect(labelsRemovalMessage('bug')).toBe('Label "bug" removed')
  })
  test('bulk snapshots capture previous values and skip unchanged issues', () => {
    const issues = [
      { key: 'A-1', priority: { id: 1 } },
      { key: 'A-2', priority: { id: 2 } },
    ]
    const snaps = buildBulkSnapshots(issues, 'priority', (i) => i.priority)
    expect(snaps).toEqual([
      { key: 'A-1', previous: { priority: { id: 1 } } },
      { key: 'A-2', previous: { priority: { id: 2 } } },
    ])
    expect(changedSnapshots(snaps, 'priority', { id: 1 }).map((s) => s.key)).toEqual(['A-2'])
  })
})
