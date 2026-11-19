import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { securityHeaders } from './security-headers'

describe('securityHeaders', () => {
  const app = new Hono()
  app.use('*', securityHeaders())
  app.get('/a', (c) => c.json({ ok: true }))
  app.get('/b', (c) => c.body('x', 200, { 'X-Frame-Options': 'SAMEORIGIN' }))
  app.get('/r', (c) => c.redirect('/a'))

  test('sets baseline headers on normal, redirect and 404 responses', async () => {
    for (const path of ['/a', '/r', '/missing']) {
      const res = await app.request(path)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    }
  })
  test('does not override headers set by a route and sets no HSTS/CSP', async () => {
    const res = await app.request('/b')
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(res.headers.get('strict-transport-security')).toBeNull()
    expect(res.headers.get('content-security-policy')).toBeNull()
  })
})
