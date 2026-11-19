import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { numericIdGuard } from './request-guards'

function app() {
  const a = new Hono()
  a.use('*', numericIdGuard())
  a.get('/things/:id', (c) => c.json({ id: c.req.param('id') }))
  a.get('/boards/:boardId/columns', (c) => c.json({ ok: true }))
  a.get('/things/:moduleKey', (c) => c.json({ moduleKey: c.req.param('moduleKey') })) // never reached: same pattern as :id, kept to show the order
  a.put('/modules/:moduleKey', (c) => c.json({ moduleKey: c.req.param('moduleKey') }))
  return a
}

describe('numericIdGuard', () => {
  test('answers 404 for a non-numeric :id', async () => {
    expect((await app().request('/things/abc')).status).toBe(404)
  })
  test('answers 404 for a non-numeric :xxxId and for ids beyond 32 bits', async () => {
    expect((await app().request('/boards/abc/columns')).status).toBe(404)
    expect((await app().request('/things/99999999999')).status).toBe(404)
  })
  test('lets valid integer ids through', async () => {
    expect((await app().request('/things/42')).status).toBe(200)
    expect((await app().request('/boards/7/columns')).status).toBe(200)
  })
  test('does not touch a string parameter that is not named like an id', async () => {
    const res = await app().request('/modules/timesheets', { method: 'PUT' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ moduleKey: 'timesheets' })
  })
})

describe('module enable/disable route', () => {
  // Regression: PUT /rest/api/2/modules/:id answered 404 for every real module id ("timesheets", "itsm", ...) because the guard treats
  // every `:id` as an integer. The route must use a parameter name the guard does not treat as a database id.
  test('does not use an :id parameter for the string module id', () => {
    const src = readFileSync(join(import.meta.dir, '../modules/host.ts'), 'utf8')
    expect(src).not.toMatch(/app\.put\('\/rest\/api\/2\/modules\/:id'/)
    expect(src).toMatch(/app\.put\('\/rest\/api\/2\/modules\/:moduleKey'/)
  })
})
