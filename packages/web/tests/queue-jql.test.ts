import { describe, test, expect } from 'bun:test'
import { jqlErrorFrom } from '../lib/queue-jql'

describe('jqlErrorFrom', () => {
  test('reads message and position', () => {
    expect(jqlErrorFrom({ body: { jqlError: { message: 'Unexpected AND', position: 28 } } })).toEqual({ message: 'Unexpected AND', position: 28 })
  })
  test('falls back to errors.jql without position', () => {
    expect(jqlErrorFrom({ body: { errors: { jql: 'bad' } } })).toEqual({ message: 'bad', position: null })
  })
  test('other errors are not JQL errors', () => {
    expect(jqlErrorFrom(new Error('x'))).toBeNull()
    expect(jqlErrorFrom(null)).toBeNull()
  })
})
