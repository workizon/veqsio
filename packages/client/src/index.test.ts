import { describe, test, expect } from 'bun:test'
import { VeqsioClient, VeqsioError, kindForStatus } from './index'

function fakeFetch(reply: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const f = (async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    return reply(url, init)
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('VeqsioClient', () => {
  test('sends the bearer token, JSON body and query, and strips a trailing slash from the base URL', async () => {
    const { f, calls } = fakeFetch(() => Response.json({ startAt: 0, maxResults: 5, total: 0, issues: [] }))
    const c = new VeqsioClient({ baseUrl: 'https://v.example.com//', token: 'veqsio_x', fetch: f })
    await c.searchIssues('project = A', 10, 5)
    expect(calls[0].url.toString()).toBe('https://v.example.com/rest/api/2/search?jql=project+%3D+A&startAt=10&maxResults=5')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer veqsio_x')
  })

  test('the public API is anonymous even when a token is configured', async () => {
    const { f, calls } = fakeFetch(() => Response.json({ projects: [] }))
    const c = new VeqsioClient({ baseUrl: 'https://v', token: 'veqsio_x', fetch: f })
    await c.publicProjects()
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  test('maps statuses to error kinds and keeps the server messages', async () => {
    expect([401, 403, 404, 402, 429, 500, 400].map(kindForStatus)).toEqual(['auth', 'forbidden', 'not_found', 'license', 'rate_limited', 'server', 'validation'])
    const { f } = fakeFetch(() => Response.json({ errorMessages: ['bad jql'] }, { status: 400 }))
    const err = await new VeqsioClient({ baseUrl: 'https://v', fetch: f }).searchIssues('x').catch((e) => e)
    expect(err).toBeInstanceOf(VeqsioError)
    expect(err.kind).toBe('validation')
    expect(err.messages).toEqual(['bad jql'])
  })

  test('network failures become VeqsioError(network)', async () => {
    const f = (async () => { throw new TypeError('connection refused') }) as unknown as typeof fetch
    const err = await new VeqsioClient({ baseUrl: 'https://v', fetch: f }).myself().catch((e) => e)
    expect(err.kind).toBe('network')
    expect(err.message).toContain('connection refused')
  })

  test('release notes are returned as text; empty bodies as undefined', async () => {
    const { f } = fakeFetch((url) => (url.pathname.endsWith('release-notes') ? new Response('# Notes') : new Response('', { status: 200 })))
    const c = new VeqsioClient({ baseUrl: 'https://v', token: 't', fetch: f })
    expect(await c.releaseNotes('A', 1)).toBe('# Notes')
    expect(await c.transition('A-1', 5)).toBeUndefined()
  })
})
