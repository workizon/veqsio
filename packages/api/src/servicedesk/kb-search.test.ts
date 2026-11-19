import { describe, test, expect } from 'bun:test'
import { tokenize, snippetAround, rankArticles } from './kb-search'

const art = (id: number, title: string, body: string, helpful = 0, views = 0) => ({ id, title, body, labels: [], helpful, views })

describe('knowledge base search', () => {
  test('tokenize drops short words and stop words', () => {
    expect(tokenize('How do I reset my VPN password?')).toEqual(['reset', 'vpn', 'password'])
    expect(tokenize('  ')).toEqual([])
    expect(tokenize('Wi-Fi keeps dropping, wifi!')).toEqual(['keeps', 'dropping', 'wifi'])
  })
  test('title matches outrank body matches; ties go to helpful articles', () => {
    const hits = rankArticles([
      art(1, 'Printing guide', 'You can reset the password of the printer queue here', 0, 0),
      art(2, 'Reset your password', 'Use the link', 0, 0),
      art(3, 'Password policy', 'password rules', 5, 10),
    ], 'I forgot my password, need to reset')
    expect(hits.map((h) => h.id)).toEqual([2, 3, 1])
  })
  test('articles without any match are dropped; nothing matches an empty question', () => {
    expect(rankArticles([art(1, 'Printers', 'toner')], 'vpn')).toEqual([])
    expect(rankArticles([art(1, 'Printers', 'toner')], 'a it')).toEqual([])
  })
  test('the snippet is centred on the match and marks the cut', () => {
    const body = `${'intro '.repeat(60)}the VPN client must be restarted after an update ${'outro '.repeat(60)}`
    const s = snippetAround(body, ['vpn'])
    expect(s).toContain('VPN client')
    expect(s.startsWith('… ')).toBe(true)
    expect(s.endsWith(' …')).toBe(true)
    expect(s.length).toBeLessThan(260)
    expect(snippetAround('short text', ['x'])).toBe('short text')
  })
})
