import { describe, test, expect, afterEach } from 'bun:test'
import { registerWorklogGuard, unregisterHooks, runWorklogGuards, worklogGuardCount } from './hooks'
import { matchRouteDecl } from './host'

const change = { action: 'update' as const, worklogId: 1, issueId: 1, issueKey: 'A-1', authorId: 1, actorId: 1, started: new Date(), previousStarted: new Date() }

describe('worklog guard hook', () => {
  afterEach(() => { unregisterHooks('a'); unregisterHooks('b') })

  test('no guards: allowed', async () => {
    expect(await runWorklogGuards(change)).toBeNull()
  })
  test('a veto is returned with its status, default 423', async () => {
    registerWorklogGuard('a', () => ({ allow: false, message: 'locked' }))
    expect(await runWorklogGuards(change)).toEqual({ message: 'locked', status: 423 })
    registerWorklogGuard('a', () => ({ allow: false, message: 'busy', status: 409 }))
    expect(await runWorklogGuards(change)).toEqual({ message: 'busy', status: 409 })
  })
  test('returning nothing allows; the first veto wins across modules', async () => {
    registerWorklogGuard('a', async () => undefined)
    registerWorklogGuard('b', async () => ({ allow: false, message: 'no' }))
    expect((await runWorklogGuards(change))?.message).toBe('no')
    expect(worklogGuardCount()).toBe(2)
  })
  test('a guard that throws fails closed', async () => {
    const orig = console.error
    console.error = () => {}
    registerWorklogGuard('a', () => { throw new Error('boom') })
    const r = await runWorklogGuards(change)
    console.error = orig
    expect(r?.status).toBe(409)
  })
  test('unregister removes the guard', async () => {
    const off = registerWorklogGuard('a', () => ({ allow: false, message: 'x' }))
    off()
    expect(await runWorklogGuards(change)).toBeNull()
  })
})

describe('module route declarations', () => {
  const decls = [
    { method: 'GET' as const, path: '/notes/:id', permission: 'authenticated' as const },
    { method: 'POST' as const, path: '/admin/*', permission: 'admin' as const },
  ]
  test('matches params and wildcards by method', () => {
    expect(matchRouteDecl(decls, 'GET', '/notes/5')?.permission).toBe('authenticated')
    expect(matchRouteDecl(decls, 'POST', '/admin/a/b')?.permission).toBe('admin')
    expect(matchRouteDecl(decls, 'DELETE', '/notes/5')).toBeNull()
    expect(matchRouteDecl(decls, 'GET', '/other')).toBeNull()
  })
  test('a catch-all declaration serves everything', () => {
    expect(matchRouteDecl([{ method: '*', path: '/*', permission: 'authenticated' }], 'PUT', '/a/b/c')).not.toBeNull()
  })
})
