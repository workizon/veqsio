import { describe, test, expect } from 'bun:test'
import { parsePeekKey, parsePeekMode, withPeek } from '../lib/peek'
import { SHORTCUTS } from '../lib/shortcuts'

describe('parsePeekKey', () => {
  test('accepts issue keys and normalises case', () => {
    expect(parsePeekKey('APP-12')).toBe('APP-12')
    expect(parsePeekKey(' app-7 ')).toBe('APP-7')
    expect(parsePeekKey('A1_B-100')).toBe('A1_B-100')
  })
  test('rejects anything else', () => {
    for (const bad of [null, undefined, '', 'APP', '12', 'APP-', 'APP-x', '../../etc', 'APP-1/../x', 'APP-1<script>', '-1', 'A'.repeat(30) + '-1']) {
      expect(parsePeekKey(bad as any), String(bad)).toBeNull()
    }
  })
})

describe('withPeek', () => {
  test('adds, replaces and removes the parameter while keeping the rest', () => {
    expect(withPeek('', 'APP-1')).toBe('?peek=APP-1')
    expect(withPeek('?jql=project%20%3D%20APP', 'app-2')).toBe('?jql=project+%3D+APP&peek=APP-2')
    expect(withPeek('?peek=APP-1&x=1', 'APP-3')).toBe('?peek=APP-3&x=1')
    expect(withPeek('?peek=APP-1&x=1', null)).toBe('?x=1')
    expect(withPeek('?peek=APP-1', null)).toBe('')
  })
  test('an invalid key removes the parameter instead of writing it', () => {
    expect(withPeek('?peek=APP-1', 'nope')).toBe('')
    expect(withPeek('', '<x>')).toBe('')
  })
})

describe('mode and shortcut', () => {
  test('mode defaults to the side panel', () => {
    expect(parsePeekMode('modal')).toBe('modal')
    expect(parsePeekMode('side')).toBe('side')
    expect(parsePeekMode('junk')).toBe('side')
    expect(parsePeekMode(null)).toBe('side')
  })
  test('the issue list has a peek shortcut', () => {
    expect(SHORTCUTS.some((s) => s.id === 'issueList.peek')).toBe(true)
  })
})
