import { describe, test, expect } from 'bun:test'
import {
  normalizeCategory, transitionCategory, transitionLabel, sortTransitions, extraRequiredFields, transitionNeedsDialog,
  validateTransitionForm, buildTransitionPayload, formatSeconds, computeTimeTracking, relativeTime, mergeActivity,
  buildThreads, groupLinks, linkRequest, subtaskProgress, formatBytes, isImageAttachment, isPdfAttachment,
  attachmentPreviewUrl, patchIssueFields,
} from '../lib/issue-view'

const t = (id: number, name: string, to: string, cat: string, extra: Record<string, unknown> = {}) => ({
  id, name, to: { id: id * 10, name: to, statusCategory: { key: cat } }, ...extra,
})

describe('categories and transitions', () => {
  test('normalizeCategory accepts every spelling', () => {
    expect(normalizeCategory('to_do')).toBe('todo')
    expect(normalizeCategory('todo')).toBe('todo')
    expect(normalizeCategory('In Progress')).toBe('in_progress')
    expect(normalizeCategory('indeterminate')).toBe('in_progress')
    expect(normalizeCategory('done')).toBe('done')
    expect(normalizeCategory(undefined)).toBe('todo')
  })
  test('transitionCategory prefers normalizedKey from the API', () => {
    expect(transitionCategory({ id: 1, name: 'x', to: { id: 1, name: 'y', statusCategory: { key: 'weird', normalizedKey: 'done' } } })).toBe('done')
    expect(transitionCategory(t(1, 'a', 'b', 'to_do'))).toBe('todo')
  })
  test('transitionLabel shows name and target, collapsing identical names', () => {
    expect(transitionLabel(t(1, 'Start Progress', 'In Progress', 'in_progress'))).toBe('Start Progress → In Progress')
    expect(transitionLabel(t(1, 'Done', 'Done', 'done'))).toBe('Done')
  })
  test('sortTransitions groups by category and keeps workflow order inside a group', () => {
    const sorted = sortTransitions([t(1, 'Close', 'Closed', 'done'), t(2, 'Reopen', 'Open', 'todo'), t(3, 'Start', 'WIP', 'in_progress'), t(4, 'Resolve', 'Resolved', 'done')])
    expect(sorted.map((x) => x.id)).toEqual([2, 3, 1, 4])
  })
  test('dialog is needed for resolution, comment, extra fields or screens', () => {
    expect(transitionNeedsDialog(t(1, 'a', 'b', 'todo', { requiresInput: false }))).toBe(false)
    expect(transitionNeedsDialog(t(1, 'a', 'b', 'done', { requiresResolution: true }))).toBe(true)
    expect(transitionNeedsDialog(t(1, 'a', 'b', 'todo', { hasScreen: true }))).toBe(true)
    expect(transitionNeedsDialog(t(1, 'a', 'b', 'todo', { fields: { environment: { required: true } } }))).toBe(true)
    expect(transitionNeedsDialog(t(1, 'a', 'b', 'todo', {}))).toBe(false)
  })
  test('extraRequiredFields excludes resolution and comment', () => {
    const tr = t(1, 'a', 'b', 'done', { requiredFields: ['comment', 'environment'], fields: { resolution: { required: true }, labels: { required: true }, other: { required: false } } })
    expect(extraRequiredFields(tr).sort()).toEqual(['environment', 'labels'])
  })
  test('validateTransitionForm reports what is missing', () => {
    const tr = t(1, 'Resolve', 'Done', 'done', { requiresResolution: true, requiresComment: true, requiredFields: ['environment'] })
    expect(validateTransitionForm(tr, { resolutionId: '', comment: ' ', extra: {} })).toEqual(['Resolution is required', 'Comment is required', 'environment is required'])
    expect(validateTransitionForm(tr, { resolutionId: '2', comment: 'ok', extra: { environment: 'prod' } })).toEqual([])
  })
  test('buildTransitionPayload shapes fields', () => {
    const tr = t(7, 'Resolve', 'Done', 'done')
    expect(buildTransitionPayload(tr)).toEqual({ transitionId: 7, fields: {} })
    expect(buildTransitionPayload(tr, { resolutionId: '3', comment: ' hi ', extra: { environment: ' prod ', empty: ' ' } })).toEqual({
      transitionId: 7, fields: { resolution: { id: 3 }, environment: 'prod', comment: 'hi' },
    })
  })
})

describe('time tracking', () => {
  test('formatSeconds uses 8h days and 5d weeks', () => {
    expect(formatSeconds(null)).toBe('None')
    expect(formatSeconds(0, '0m')).toBe('0m')
    expect(formatSeconds(90 * 60)).toBe('1h 30m')
    expect(formatSeconds(8 * 3600)).toBe('1d')
    expect(formatSeconds(5 * 8 * 3600 + 3600)).toBe('1w 1h')
  })
  test('computeTimeTracking', () => {
    expect(computeTimeTracking(null, null)).toMatchObject({ hasData: false, remaining: null, spentPercent: 0 })
    expect(computeTimeTracking(null, 3600)).toMatchObject({ hasData: true, remaining: null, spentPercent: 100 })
    expect(computeTimeTracking(7200, 1800)).toMatchObject({ remaining: 5400, spentPercent: 25, remainingPercent: 75, overrun: false })
    expect(computeTimeTracking(3600, 7200)).toMatchObject({ remaining: 0, spentPercent: 100, remainingPercent: 0, overrun: true })
  })
})

describe('relativeTime', () => {
  const now = new Date('2026-01-10T12:00:00Z')
  test('buckets', () => {
    expect(relativeTime('2026-01-10T11:59:50Z', now)).toBe('just now')
    expect(relativeTime('2026-01-10T11:50:00Z', now)).toBe('10 minutes ago')
    expect(relativeTime('2026-01-10T09:00:00Z', now)).toBe('3 hours ago')
    expect(relativeTime('2026-01-09T11:00:00Z', now)).toBe('1 day ago')
    expect(relativeTime('2025-12-01T12:00:00Z', now)).toBe('1 month ago')
    expect(relativeTime('2026-01-12T12:00:00Z', now)).toBe('in 2 days')
    expect(relativeTime(null, now)).toBe('')
    expect(relativeTime('garbage', now)).toBe('')
  })
})

describe('activity', () => {
  const comments = [
    { id: '1', created: '2026-01-01T10:00:00Z', body: 'a' },
    { id: '2', created: '2026-01-03T10:00:00Z', body: 'b', parentId: '1' },
    { id: '3', created: '2026-01-02T10:00:00Z', body: 'c' },
  ]
  const histories = [
    { id: 'h1', created: '2026-01-02T12:00:00Z', items: [{ field: 'status' }, { field: 'priority' }] },
  ]
  test('newest first merges and hides replies', () => {
    const feed = mergeActivity(comments, histories)
    expect(feed.map((e) => e.type)).toEqual(['history', 'history', 'comment', 'comment'])
    expect(feed.slice(2).map((e) => e.key)).toEqual(['comment-3', 'comment-1'])
    expect(feed.some((e) => e.key === 'comment-2')).toBe(false)
  })
  test('oldest first reverses', () => {
    const feed = mergeActivity(comments, histories, { newestFirst: false })
    expect(feed[0].key).toBe('comment-1')
    expect(feed[feed.length - 1].type).toBe('history')
  })
  test('filters', () => {
    expect(mergeActivity(comments, histories, { filter: 'comments' }).every((e) => e.type === 'comment')).toBe(true)
    expect(mergeActivity(comments, histories, { filter: 'history' })).toHaveLength(2)
  })
  test('orphan reply (parent missing) is kept as a top-level comment', () => {
    const feed = mergeActivity([{ id: '9', created: '2026-01-01T00:00:00Z', parentId: '404' }], [])
    expect(feed).toHaveLength(1)
  })
  test('threads: root resolution flattens deep replies and survives cycles', () => {
    const list = [
      { id: '1', created: '2026-01-01T00:00:00Z' },
      { id: '2', created: '2026-01-02T00:00:00Z', parentId: '1' },
      { id: '3', created: '2026-01-01T12:00:00Z', parentId: '2' },
      { id: 'a', created: '2026-01-01T00:00:00Z', parentId: 'b' },
      { id: 'b', created: '2026-01-01T00:00:00Z', parentId: 'a' },
    ]
    const { rootOf, repliesByRoot } = buildThreads(list)
    expect(rootOf(list[2])).toBe('1')
    expect(repliesByRoot.get('1')!.map((c) => c.id)).toEqual(['3', '2'])
    expect(() => rootOf(list[3])).not.toThrow()
  })
})

describe('links and sub-tasks', () => {
  const blocks = { id: 1, name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }
  const links = [
    { id: 1, type: blocks, inwardIssue: { id: 2, key: 'A-2', summary: 's' } },
    { id: 2, type: blocks, outwardIssue: { id: 3, key: 'A-3', summary: 's' } },
    { id: 3, type: blocks, inwardIssue: { id: 4, key: 'A-4', summary: 's' } },
    { id: 4, type: { id: 2, name: 'Relates' }, inwardIssue: { id: 5, key: 'A-5', summary: 's' } },
    { id: 5, type: { id: 2, name: 'Relates' } },
  ]
  test('groupLinks groups by displayed sentence and skips broken links', () => {
    const g = groupLinks(links)
    expect(g.map((x) => x.label)).toEqual(['is blocked by', 'blocks', 'Relates'])
    expect(g[0].links.map((l) => l.issue.key)).toEqual(['A-2', 'A-4'])
    expect(groupLinks(null)).toEqual([])
  })
  test('linkRequest realises the chosen sentence', () => {
    expect(linkRequest(1, 2, 'outward')).toEqual({ inwardIssue: { id: 2 }, outwardIssue: { id: 1 } })
    expect(linkRequest(1, 2, 'inward')).toEqual({ inwardIssue: { id: 1 }, outwardIssue: { id: 2 } })
  })
  test('subtaskProgress', () => {
    expect(subtaskProgress([])).toMatchObject({ total: 0, donePercent: 0 })
    expect(subtaskProgress([{ category: 'done' }, { category: 'to_do' }, { category: 'in_progress' }, { category: 'done' }])).toEqual({
      total: 4, done: 2, inProgress: 1, todo: 1, donePercent: 50, inProgressPercent: 25,
    })
  })
})

describe('attachments', () => {
  test('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
  })
  test('isImageAttachment', () => {
    expect(isImageAttachment({ mimeType: 'image/png' })).toBe(true)
    expect(isImageAttachment({ mimeType: 'application/octet-stream', filename: 'x.JPG' })).toBe(true)
    expect(isImageAttachment({ mimeType: 'application/pdf', filename: 'x.pdf' })).toBe(false)
  })
  test('PDF attachments use the authenticated inline preview endpoint', () => {
    expect(isPdfAttachment({ mimeType: 'application/pdf' })).toBe(true)
    expect(isPdfAttachment({ mimeType: 'application/octet-stream' })).toBe(false)
    expect(isPdfAttachment({ mimeType: 'text/plain' })).toBe(false)
    expect(attachmentPreviewUrl({ id: '7', mimeType: 'application/pdf' }))
      .toBe('/rest/api/2/attachment/7?inline=1')
    expect(attachmentPreviewUrl({ id: '7', mimeType: 'text/plain' })).toBeNull()
  })
})

describe('patchIssueFields (optimistic)', () => {
  const issue = {
    fields: {
      summary: 'old', assignee: null, priority: { id: 1, name: 'Low' }, labels: ['a'],
      components: [{ id: 1, name: 'API' }], fixVersions: [], duedate: null,
    } as Record<string, any>,
  }
  test('plain fields and labels', () => {
    const next = patchIssueFields(issue, { summary: 'new', labels: ['a', 'b'], duedate: '2026-02-01' })
    expect(next.fields.summary).toBe('new')
    expect(next.fields.labels).toEqual(['a', 'b'])
    expect(next.fields.duedate).toBe('2026-02-01')
    expect(issue.fields.summary).toBe('old')
  })
  test('assignee and priority resolve through lookups, clearing works', () => {
    const lookup = { users: [{ id: 5, displayName: 'Ann' }], priorities: [{ id: '2', name: 'High', color: 'red' }] }
    const a = patchIssueFields(issue, { assignee: { id: 5 }, priority: { id: 2 } }, lookup)
    expect(a.fields.assignee).toEqual({ id: 5, displayName: 'Ann' })
    expect(a.fields.priority).toEqual({ id: 2, name: 'High', color: 'red' })
    expect(patchIssueFields(a, { assignee: null }).fields.assignee).toBeNull()
  })
  test('components resolve from lookup or current value', () => {
    const next = patchIssueFields(issue, { components: [1, 2] }, { components: [{ id: 2, name: 'Web' }] })
    expect(next.fields.components).toEqual([{ id: 1, name: 'API' }, { id: 2, name: 'Web' }])
  })
})

describe('cancelled sub-tasks', () => {
  test('are closed but excluded from progress', async () => {
    const { subtaskProgress, normalizeCategory } = await import('../lib/issue-view')
    expect(normalizeCategory('cancelled')).toBe('done')
    expect(normalizeCategory('backlog')).toBe('todo')
    const p = subtaskProgress([{ category: 'done' }, { category: 'cancelled' }, { category: 'to_do' }])
    expect(p.total).toBe(2)
    expect(p.donePercent).toBe(50)
  })
})
