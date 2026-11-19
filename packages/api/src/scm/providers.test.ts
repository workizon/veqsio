import { afterEach, describe, expect, test } from 'bun:test'
import { createBranch, ScmError, setScmFetch } from './providers'

afterEach(() => setScmFetch(null))

describe('SCM provider calls', () => {
  test('a redirect from the provider is refused, never followed (SSRF via 3xx)', async () => {
    const seen: string[] = []
    setScmFetch(async (url) => {
      seen.push(url)
      return new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    })
    const repo = { provider: 'github' as const, baseUrl: null, name: 'o/r', defaultBranch: 'main' }
    await expect(createBranch(repo, 'token', 'feature-x', 'main')).rejects.toThrow(ScmError)
    // only the original provider URL was requested
    expect(seen.every((u) => !u.includes('169.254'))).toBe(true)
  })
})
