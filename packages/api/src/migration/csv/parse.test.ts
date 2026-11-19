import { describe, it, expect } from 'bun:test'
import { parseCsv, suggestMapping, validateMapping, parseDate, parseCommentCell, parseDurationSeconds, splitList, cells, parseStoryPointsCell } from './parse'

describe('parseCsv', () => {
  it('handles quotes, newlines, BOM and repeated headers', () => {
    const csv = '﻿Summary,Description,Labels,Labels\n"Hello, world","line1\nline2",a,b\nSecond,,,\n'
    const p = parseCsv(csv)
    expect(p.headers).toEqual(['Summary', 'Description', 'Labels', 'Labels'])
    expect(p.rows).toHaveLength(2)
    expect(p.rows[0]).toEqual(['Hello, world', 'line1\nline2', 'a', 'b'])
  })
  it('rejects header-only files', () => {
    expect(() => parseCsv('Summary\n')).toThrow()
  })
})

describe('suggestMapping', () => {
  it('maps Jira export headers including repeated multi columns', () => {
    const h = ['Summary', 'Issue key', 'Issue id', 'Issue Type', 'Status', 'Labels', 'Labels', 'Component/s', 'Parent', 'Comment', 'Comment']
    const m = suggestMapping(h)
    expect(m.summary).toEqual([0])
    expect(m.issueKey).toEqual([1])
    expect(m.issueType).toEqual([3])
    expect(m.labels).toEqual([5, 6])
    expect(m.comment).toEqual([9, 10])
    expect(m.parent).toEqual([8])
  })
  it('validates', () => {
    expect(validateMapping({}, 3)).toContain('Map a column to Summary (required)')
    expect(validateMapping({ summary: [5] }, 3)[0]).toMatch(/Invalid column/)
    expect(validateMapping({ summary: [0, 1] }, 3)[0]).toMatch(/single column/)
    expect(validateMapping({ summary: [0], labels: [1, 2] }, 3)).toEqual([])
  })
})

describe('parseDate', () => {
  it('parses Jira and ISO formats', () => {
    expect(parseDate('15/Mar/23 2:30 PM')?.toISOString()).toBe('2023-03-15T14:30:00.000Z')
    expect(parseDate('01/Jan/2020 12:05 AM')?.toISOString()).toBe('2020-01-01T00:05:00.000Z')
    expect(parseDate('2023-03-15 10:00')?.toISOString()).toBe('2023-03-15T10:00:00.000Z')
    expect(parseDate('2023-03-15T10:00:00+0200')?.toISOString()).toBe('2023-03-15T08:00:00.000Z')
    expect(parseDate('15.03.2023 14:30')?.toISOString()).toBe('2023-03-15T14:30:00.000Z')
  })
  it('respects numeric order and rejects garbage', () => {
    expect(parseDate('03/04/2023', 'dmy')?.toISOString()).toBe('2023-04-03T00:00:00.000Z')
    expect(parseDate('03/04/2023', 'mdy')?.toISOString()).toBe('2023-03-04T00:00:00.000Z')
    expect(parseDate('31/02/2023', 'dmy')).toBeNull()
    expect(parseDate('yesterday')).toBeNull()
    expect(parseDate('')).toBeNull()
  })
})

describe('helpers', () => {
  it('parses comment cells', () => {
    expect(parseCommentCell('15/Mar/23 2:30 PM;alice;Hello; there')).toMatchObject({ author: 'alice', body: 'Hello; there' })
    expect(parseCommentCell('just text')).toEqual({ created: null, author: null, body: 'just text' })
  })
  it('parses durations and lists', () => {
    expect(parseDurationSeconds('3600')).toBe(3600)
    expect(parseDurationSeconds('1d 2h')).toBe(28800 + 7200)
    expect(parseDurationSeconds('abc')).toBeNull()
    expect(splitList(['a, b', 'b;c'])).toEqual(['a', 'b', 'c'])
    expect(cells(['x', '', 'y'], { labels: [0, 1, 2] }, 'labels')).toEqual(['x', 'y'])
  })
})

describe('story points', () => {
  it('suggests the mapping from Jira header variants', () => {
    expect(suggestMapping(['Summary', 'Story Points']).storyPoints).toEqual([1])
    expect(suggestMapping(['Summary', 'Story point estimate']).storyPoints).toEqual([1])
    expect(suggestMapping(['Summary', 'Custom field (Story Points)']).storyPoints).toEqual([1])
  })
  it('parses cells', () => {
    expect(parseStoryPointsCell('5')).toBe(5)
    expect(parseStoryPointsCell('3,5')).toBe(3.5)
    expect(parseStoryPointsCell('0.125')).toBe(0.13)
    expect(parseStoryPointsCell('-1')).toBeNull()
    expect(parseStoryPointsCell('1001')).toBeNull()
    expect(parseStoryPointsCell('abc')).toBeNull()
    expect(parseStoryPointsCell(null)).toBeNull()
  })
})

describe('suggestMapping for exports of other tools', () => {
  it('Asana, ClickUp and Linear column names', () => {
    const asana = suggestMapping(['Task ID', 'Created At', 'Completed At', 'Last Modified', 'Name', 'Section/Column', 'Assignee', 'Assignee Email', 'Due Date', 'Tags', 'Notes', 'Parent task'])
    expect(asana.summary).toEqual([4])
    expect(asana.status).toEqual([5])
    expect(asana.assignee).toEqual([6])
    expect(asana.description).toEqual([10])
    expect(asana.labels).toEqual([9])
    expect(asana.parent).toEqual([11])
    expect(asana.resolved).toEqual([2])
    const clickup = suggestMapping(['Task ID', 'Task Name', 'Status', 'Task Content', 'Tags', 'Date Created', 'Due Date'])
    expect(clickup.summary).toEqual([1])
    expect(clickup.description).toEqual([3])
    expect(clickup.created).toEqual([5])
    const linear = suggestMapping(['ID', 'Title', 'Status', 'Estimate', 'Priority', 'Labels', 'Created', 'Parent issue'])
    expect(linear.summary).toEqual([1])
    expect(linear.storyPoints).toEqual([3])
    expect(linear.parent).toEqual([7])
  })
})
