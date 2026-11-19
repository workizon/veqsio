import { describe, it, expect } from 'bun:test'
import { escapeTemplateData } from './email'

describe('email template escaping', () => {
  it('escapes nested strings and leaves other types alone', () => {
    const out = escapeTemplateData({ summary: '<img src=x onerror=alert(1)>', n: 3, list: ['a&b'], nested: { q: `"'` }, none: null })
    expect(out).toEqual({ summary: '&lt;img src=x onerror=alert(1)&gt;', n: 3, list: ['a&amp;b'], nested: { q: '&quot;&#39;' }, none: null })
  })
})
