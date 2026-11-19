import { describe, expect, test } from 'bun:test'
import { tokenize } from './lexer'
import { parseJQLTokens } from './parser'
import { resolveCustomFieldAlias } from './translator'

const parse = (q: string) => parseJQLTokens(tokenize(q)) as any

describe('custom fields in JQL, the Jira way', () => {
  test('cf[10042] is the field customfield_10042', () => {
    const ast = parse('cf[10042] = High')
    const clause = ast.type === 'query' ? ast.where : ast
    expect(clause.field).toBe('customfield_10042')
  })
  test('cf with spaces and in lists', () => {
    expect(parse('project = A AND cf[7] in (1, 2)')).toBeDefined()
  })
  test('a field named in quotes', () => {
    const ast = parse('"Customer impact" = High')
    const clause = ast.type === 'query' ? ast.where : ast
    expect(clause.field).toBe('Customer impact')
  })
  test('quoted values after a field are still values', () => {
    const ast = parse('summary ~ "Customer impact"')
    const clause = ast.type === 'query' ? ast.where : ast
    expect(clause.field).toBe('summary')
  })
  test('cf alone is an ordinary word, not a field reference', () => {
    expect(tokenize('cf = 1').map((t) => t.value)).toContain('cf')
  })
})

describe('resolving custom field spellings', () => {
  const ctx = { customFieldNames: { 'customer impact': 5 }, customFieldJiraIds: { 10042: 8 } }
  test("Jira's id maps to the field it was imported as", () => { expect(resolveCustomFieldAlias('customfield_10042', ctx)).toBe('customfield_8') })
  test('an id without a remembered Jira id is taken as the id here', () => { expect(resolveCustomFieldAlias('customfield_3', ctx)).toBe('customfield_3') })
  test('a name', () => { expect(resolveCustomFieldAlias('Customer Impact', ctx)).toBe('customfield_5') })
  test('built-in fields are never taken for custom ones', () => { expect(resolveCustomFieldAlias('status', { customFieldNames: { status: 9 } })).toBeNull() })
  test('unknown names', () => { expect(resolveCustomFieldAlias('Nothing', ctx)).toBeNull() })
})
