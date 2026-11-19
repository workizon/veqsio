import { describe, it, expect } from 'bun:test'
import { getJqlContext, applySuggestion, formatJqlValue } from '../lib/jql-autocomplete'

const ctx = (t: string, c?: number) => getJqlContext(t, c)

describe('getJqlContext', () => {
  it('suggests fields on empty input', () => {
    expect(ctx('')).toMatchObject({ kind: 'field', prefix: '', start: 0 })
  })
  it('suggests fields for a partial word', () => {
    expect(ctx('sta')).toMatchObject({ kind: 'field', prefix: 'sta', start: 0, end: 3 })
  })
  it('suggests operators after a field + space', () => {
    expect(ctx('status ')).toMatchObject({ kind: 'operator', field: 'status', prefix: '' })
  })
  it('suggests values after an operator', () => {
    expect(ctx('status = ')).toMatchObject({ kind: 'value', field: 'status', operator: '=' })
    expect(ctx('status =')).toMatchObject({ kind: 'value', prefix: '' })
  })
  it('captures a partial value prefix', () => {
    expect(ctx('status = Op')).toMatchObject({ kind: 'value', prefix: 'Op', start: 9, field: 'status' })
  })
  it('handles an unterminated quoted value', () => {
    const c = ctx('assignee = "John D')
    expect(c).toMatchObject({ kind: 'value', quoted: true, prefix: 'John D', start: 11, field: 'assignee' })
  })
  it('suggests keywords after a complete clause', () => {
    expect(ctx('status = Open ')).toMatchObject({ kind: 'keyword' })
    expect(ctx('status = "In Progress" AN')).toMatchObject({ kind: 'keyword', prefix: 'AN' })
  })
  it('starts a new clause after AND / OR', () => {
    expect(ctx('status = Open AND ')).toMatchObject({ kind: 'field', field: undefined })
    expect(ctx('status = Open OR pri')).toMatchObject({ kind: 'field', prefix: 'pri' })
  })
  it('tracks the field of the current clause only', () => {
    expect(ctx('status = Open AND priority = ')).toMatchObject({ kind: 'value', field: 'priority' })
  })
  it('handles IN lists', () => {
    expect(ctx('status in (')).toMatchObject({ kind: 'value', inList: true })
    expect(ctx('status in (Open, ')).toMatchObject({ kind: 'value', inList: true, prefix: '' })
    expect(ctx('status in (Open, Clo')).toMatchObject({ kind: 'value', inList: true, prefix: 'Clo' })
    expect(ctx('status in (Open) ')).toMatchObject({ kind: 'keyword', inList: false })
  })
  it('handles multi-word operators', () => {
    expect(ctx('status is ')).toMatchObject({ kind: 'operator', extraKeywords: ['not', 'EMPTY', 'NULL'] })
    expect(ctx('status not ')).toMatchObject({ kind: 'operator', extraKeywords: ['in'] })
    expect(ctx('status not in ')).toMatchObject({ kind: 'value', operator: 'not in' })
    expect(ctx('assignee is not EMPTY ')).toMatchObject({ kind: 'keyword' })
  })
  it('skips over function calls', () => {
    expect(ctx('assignee = currentUser() ')).toMatchObject({ kind: 'keyword' })
    expect(ctx('assignee in membersOf("devs") AND ')).toMatchObject({ kind: 'field' })
  })
  it('handles ORDER BY', () => {
    expect(ctx('status = Open ORDER ')).toMatchObject({ kind: 'keyword', extraKeywords: ['BY'] })
    expect(ctx('status = Open ORDER BY ')).toMatchObject({ kind: 'orderField' })
    expect(ctx('ORDER BY cre')).toMatchObject({ kind: 'orderField', prefix: 'cre' })
    expect(ctx('ORDER BY created ')).toMatchObject({ kind: 'orderDirection' })
    expect(ctx('ORDER BY created DESC, ')).toMatchObject({ kind: 'orderField' })
  })
  it('handles CHANGED clauses', () => {
    expect(ctx('status changed ')).toMatchObject({ kind: 'keyword', extraKeywords: ['FROM', 'TO', 'BY', 'DURING'] })
    expect(ctx('status changed from ')).toMatchObject({ kind: 'value', field: 'status' })
  })
  it('uses the cursor position, ignoring text after it', () => {
    expect(ctx('status = Open AND priority = High', 8)).toMatchObject({ kind: 'value', prefix: '' })
    expect(ctx('stat = Open', 4)).toMatchObject({ kind: 'field', prefix: 'stat' })
  })
  it('allows NOT before a field', () => {
    expect(ctx('NOT ')).toMatchObject({ kind: 'field' })
  })
})

describe('applySuggestion', () => {
  it('replaces the partial token and adds a space', () => {
    const c = ctx('sta')
    expect(applySuggestion('sta', c, 'status')).toEqual({ text: 'status ', cursor: 7 })
  })
  it('quotes values containing spaces', () => {
    const t = 'status = In'
    expect(applySuggestion(t, ctx(t), 'In Progress', { asValue: true })).toEqual({
      text: 'status = "In Progress" ',
      cursor: 23,
    })
  })
  it('replaces an unterminated quoted prefix', () => {
    const t = 'assignee = "John'
    expect(applySuggestion(t, ctx(t), 'John Doe', { asValue: true }).text).toBe('assignee = "John Doe" ')
  })
  it('opens a parenthesised list for IN', () => {
    const t = 'status in '
    expect(applySuggestion(t, ctx(t), 'Open', { asValue: true }).text).toBe('status in (Open ')
  })
  it('does not re-open the list inside one', () => {
    const t = 'status in (Open, '
    expect(applySuggestion(t, ctx(t), 'Done', { asValue: true }).text).toBe('status in (Open, Done ')
  })
  it('inserts in the middle of text without duplicating spaces', () => {
    const t = 'sta = Open'
    const r = applySuggestion(t, ctx(t, 3), 'status')
    expect(r.text).toBe('status = Open')
    expect(r.cursor).toBe(6)
  })
  it('leaves function calls unquoted', () => {
    const t = 'assignee = '
    expect(applySuggestion(t, ctx(t), 'currentUser()', { asValue: true }).text).toBe('assignee = currentUser()')
  })
})

describe('formatJqlValue', () => {
  it('quotes only when needed', () => {
    expect(formatJqlValue('Open')).toBe('Open')
    expect(formatJqlValue('a b')).toBe('"a b"')
    expect(formatJqlValue('say "hi"')).toBe('"say \\"hi\\""')
  })
})
