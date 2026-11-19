import { describe, test, expect } from 'bun:test'
import { TERMS, capitalize, countLabel, isTerm, pluralize, termWord, termify } from '../lib/term'

describe('termWord', () => {
  test('singular, plural and capitalised forms for every option', () => {
    expect(TERMS.map((t) => termWord(t))).toEqual(['issue', 'work item', 'ticket', 'task'])
    expect(TERMS.map((t) => termWord(t, { plural: true }))).toEqual(['issues', 'work items', 'tickets', 'tasks'])
    expect(termWord('work item', { capitalize: true })).toBe('Work item')
    expect(termWord('work item', { plural: true, capitalize: true })).toBe('Work items')
  })
  test('pluralize irregular endings', () => {
    expect(pluralize('entry')).toBe('entries')
    expect(pluralize('day')).toBe('days')
    expect(pluralize('box')).toBe('boxes')
    expect(pluralize('batch')).toBe('batches')
    expect(capitalize('')).toBe('')
  })
  test('isTerm guards unknown values', () => {
    expect(isTerm('ticket')).toBe(true)
    expect(isTerm('story')).toBe(false)
    expect(isTerm(undefined)).toBe(false)
  })
})

describe('termify', () => {
  test('keeps the casing style of the original', () => {
    expect(termify('Create issue', 'task')).toBe('Create task')
    expect(termify('Search issues', 'ticket')).toBe('Search tickets')
    expect(termify('Issues', 'work item')).toBe('Work items')
    expect(termify('ISSUES', 'ticket')).toBe('TICKETS')
    expect(termify('My Issues', 'task')).toBe('My Tasks')
  })
  test('fixes the article', () => {
    expect(termify('Create an issue', 'ticket')).toBe('Create a ticket')
    expect(termify('Pick an issue', 'task')).toBe('Pick a task')
    expect(termify('a task', 'issue')).toBe('a task')
    expect(termify('No issue selected', 'work item')).toBe('No work item selected')
  })
  test('the default term leaves text untouched, tokens still resolve', () => {
    expect(termify('Create issue', 'issue')).toBe('Create issue')
    expect(termify('Your {issues} and {Issue}', 'issue')).toBe('Your issues and Issue')
    expect(termify('Your {issues} and {Issue}', 'work item')).toBe('Your work items and Work item')
  })
  test('does not touch other words that contain issue', () => {
    expect(termify('Reissue the token', 'ticket')).toBe('Reissue the token')
    expect(termify('issued by', 'ticket')).toBe('issued by')
    expect(termify('', 'ticket')).toBe('')
  })
  test('count labels pluralise', () => {
    expect(countLabel(1, 'work item')).toBe('1 work item')
    expect(countLabel(0, 'ticket')).toBe('0 tickets')
    expect(countLabel(12, 'issue')).toBe('12 issues')
  })
})
