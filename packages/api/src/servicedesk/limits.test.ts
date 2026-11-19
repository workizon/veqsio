import { describe, test, expect } from 'bun:test'
import { consumeLimit, maxRequestsPerHour, maxCommentsPerHour } from './limits'

describe('portal limiter', () => {
  test('allows up to max, then denies with a positive retryAfter', async () => {
    const key = `unit:${Math.random()}`
    for (let i = 0; i < 3; i++) expect((await consumeLimit(key, 3)).allowed).toBe(true)
    const r = await consumeLimit(key, 3)
    expect(r.allowed).toBe(false)
    expect(r.retryAfter).toBeGreaterThan(0)
    expect(r.retryAfter).toBeLessThanOrEqual(3600)
  })
  test('denied attempts are not counted and the window expires', async () => {
    const key = `unit:${Math.random()}`
    await consumeLimit(key, 1, 200)
    expect((await consumeLimit(key, 1, 200)).allowed).toBe(false)
    expect((await consumeLimit(key, 1, 200)).allowed).toBe(false)
    await Bun.sleep(250)
    expect((await consumeLimit(key, 1, 200)).allowed).toBe(true)
  })
  test('keys are independent', async () => {
    const a = `unit:${Math.random()}`, b = `unit:${Math.random()}`
    await consumeLimit(a, 1)
    expect((await consumeLimit(a, 1)).allowed).toBe(false)
    expect((await consumeLimit(b, 1)).allowed).toBe(true)
  })
  test('limits are read from env at call time with safe defaults', () => {
    delete process.env.PORTAL_MAX_REQUESTS_PER_HOUR
    expect(maxRequestsPerHour()).toBe(20)
    process.env.PORTAL_MAX_REQUESTS_PER_HOUR = '5'
    expect(maxRequestsPerHour()).toBe(5)
    process.env.PORTAL_MAX_REQUESTS_PER_HOUR = 'abc'
    expect(maxRequestsPerHour()).toBe(20)
    delete process.env.PORTAL_MAX_REQUESTS_PER_HOUR
    expect(maxCommentsPerHour()).toBe(60)
  })
})
