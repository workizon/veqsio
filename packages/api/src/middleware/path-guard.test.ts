import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { hasEncodedUnreserved, pathGuard } from './path-guard'
import { isAllowed, normalizeScopes } from './token-scopes'

describe('encoded paths', () => {
  test('letters, digits and -._~ written as %XX are refused; ordinary encodings are not', () => {
    for (const p of ['/rest/api/2/%61dmin/x', '/%41DMIN', '/a/%2e%2e/b', '/x%5Fy', '/x%7ey', '/k%31']) expect(hasEncodedUnreserved(p)).toBe(true)
    for (const p of ['/rest/api/2/admin/x', '/files/a%20b.png', '/q/%E2%9C%93', '/a%2Fb', '/x%40y']) expect(hasEncodedUnreserved(p)).toBe(false)
  })
  test('the guard answers 400 before any route or later guard sees the request', async () => {
    const app = new Hono()
    app.use('*', pathGuard())
    app.get('/rest/api/2/admin/x', (c) => c.text('admin'))
    expect((await app.request('http://x/rest/api/2/%61dmin/x')).status).toBe(400)
    expect((await app.request('http://x/rest/api/2/admin/x')).status).toBe(200)
  })
  test('a scoped token is judged by the decoded path as well', () => {
    const scopes = normalizeScopes(['read:*'])
    expect(isAllowed(scopes, 'GET', '/rest/api/2/admin/system/mail')).toBe(false)
  })
})
