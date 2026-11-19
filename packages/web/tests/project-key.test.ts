import { describe, expect, test } from 'bun:test'
import { PROJECT_KEY_RE, suggestKey } from '../lib/project-key'

describe('project key suggestion', () => {
  test('initials for several words, first letters for one word', () => {
    expect(suggestKey('Customer Portal')).toBe('CP')
    expect(suggestKey('Customer Portal 2')).toBe('CP2')
    expect(suggestKey('Veqsio')).toBe('VEQS')
    expect(suggestKey('  it   help-desk ')).toBe('IHD')
  })
  test('never starts with a digit, ignores punctuation, caps the length', () => {
    expect(suggestKey('2024 Roadmap')).toBe('R')
    expect(suggestKey('!!!')).toBe('')
    expect(suggestKey('a b c d e f g h i j k l m')).toHaveLength(10)
  })
  test('suggestions of two or more characters are valid keys', () => {
    for (const n of ['Customer Portal', 'Veqsio', 'Platform Team 9']) expect(PROJECT_KEY_RE.test(suggestKey(n))).toBe(true)
    expect(PROJECT_KEY_RE.test('A')).toBe(false)
    expect(PROJECT_KEY_RE.test('1AB')).toBe(false)
  })
})
