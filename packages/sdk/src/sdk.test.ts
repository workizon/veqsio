import { describe, test, expect } from 'bun:test'
import {
  compareVersions, satisfies, isValidRange, parseVersion,
  parseManifest, ManifestError, defineModule, moduleTablePrefix,
  validateSettings, redactSettings, settingsDefaults, SECRET_PLACEHOLDER,
  createEventBus, createModuleApiClient, ModuleApiError,
  type SettingsSchema,
} from './index'

const base = {
  id: 'demo-app', name: 'Demo', version: '1.0.0', vendor: 'Acme', description: 'A demo',
  license: 'AGPL-3.0-or-later', engines: { veqsio: '>=1.0.0 <2.0.0' },
}

describe('semver', () => {
  test('parses and compares', () => {
    expect(parseVersion('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['beta', '1'] })
    expect(parseVersion('1.2')).toBeNull()
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compareVersions('1.0.0+build', '1.0.0')).toBe(0)
    expect(() => compareVersions('x', '1.0.0')).toThrow()
  })
  test('ranges', () => {
    expect(satisfies('1.4.0', '^1.2.0')).toBe(true)
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false)
    expect(satisfies('0.2.5', '^0.2.1')).toBe(true)
    expect(satisfies('0.3.0', '^0.2.1')).toBe(false)
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true)
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false)
    expect(satisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false)
    expect(satisfies('1.0.0', '1.x')).toBe(true)
    expect(satisfies('3.1.0', '*')).toBe(true)
    expect(satisfies('1.2.3', '1.2.3')).toBe(true)
    expect(satisfies('1.2.4', '1.2.3')).toBe(false)
    expect(satisfies('3.0.0', '^1.0.0 || ^3.0.0')).toBe(true)
    expect(satisfies('2.0.0', '^1.0.0 || ^3.0.0')).toBe(false)
    expect(satisfies('1.5.0', '1.0.0 - 1.9.0')).toBe(true)
    expect(satisfies('2.0.0', '1.0.0 - 1.9.0')).toBe(false)
    expect(satisfies('1.0.0', '>1.0.0')).toBe(false)
    expect(satisfies('1.0.1', '>1.0.0')).toBe(true)
  })
  test('pre-releases only match ranges that name them', () => {
    expect(satisfies('1.3.0-beta.1', '^1.2.0')).toBe(false)
    expect(satisfies('1.3.0-beta.1', '>=1.3.0-beta.0')).toBe(true)
  })
  test('invalid input', () => {
    expect(isValidRange('^1.0.0')).toBe(true)
    expect(isValidRange('banana')).toBe(false)
    expect(satisfies('nope', '^1.0.0')).toBe(false)
    expect(satisfies('1.0.0', 'banana')).toBe(false)
  })
})

describe('manifest', () => {
  test('accepts a minimal manifest and applies defaults', () => {
    const m = parseManifest(base)
    expect(m.edition).toBe('community')
    expect(m.icon).toBe('puzzle')
    expect(m.contributes.web.navItems).toEqual([])
    expect(m.contributes.server.routes).toEqual([])
    expect(m.devOnly).toBe(false)
  })
  test('rejects bad id, version and engines with readable paths', () => {
    try {
      parseManifest({ ...base, id: 'Bad_ID', version: '1.0', engines: { veqsio: 'nope' } })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError)
      const msg = (e as Error).message
      expect(msg).toContain('id:')
      expect(msg).toContain('version:')
      expect(msg).toContain('engines.veqsio')
    }
  })
  test('enterprise modules need a feature key', () => {
    expect(() => parseManifest({ ...base, edition: 'enterprise' })).toThrow(/feature/)
    expect(parseManifest({ ...base, edition: 'enterprise', feature: 'demo' }).feature).toBe('demo')
  })
  test('events need the permission, self dependency and duplicate keys are rejected', () => {
    expect(() => parseManifest({ ...base, contributes: { server: { events: ['issue.created'] } } })).toThrow(/events:subscribe/)
    expect(() => parseManifest({ ...base, dependencies: { 'demo-app': '^1.0.0' } })).toThrow(/itself/)
    expect(() => parseManifest({ ...base, contributes: { web: { navItems: [{ key: 'a', title: 'A', path: 'a' }, { key: 'a', title: 'B', path: 'b' }] } } })).toThrow(/duplicate/)
  })
  test('rejects unknown permissions, route permissions and absolute page paths', () => {
    expect(() => parseManifest({ ...base, permissions: ['root'] })).toThrow()
    expect(() => parseManifest({ ...base, contributes: { server: { routes: [{ method: 'GET', path: '/x', permission: 'GOD' }] } } })).toThrow()
    expect(() => parseManifest({ ...base, contributes: { web: { navItems: [{ key: 'a', title: 'A', path: '/abs' }] } } })).toThrow()
  })
  test('required settings must exist', () => {
    expect(() => parseManifest({ ...base, settings: { properties: { a: { type: 'string', title: 'A' } }, required: ['b'] } })).toThrow(/required setting/)
  })
  test('table prefix', () => {
    expect(moduleTablePrefix('example-notes')).toBe('example_notes_')
    expect(moduleTablePrefix('plans')).toBe('plans_')
  })
})

describe('defineModule', () => {
  const withEvents = { ...base, permissions: ['events:subscribe'], contributes: { server: { events: ['issue.created'] } } } as const
  test('cross checks events and migrations against the manifest', () => {
    expect(() => defineModule({ manifest: base, events: { 'issue.created': () => {} } })).toThrow(/not listed/)
    expect(() => defineModule({ manifest: withEvents as never })).toThrow(/no handler/)
    expect(() => defineModule({ manifest: base, migrations: [{ name: '0001_x', sql: 'select 1' }] })).toThrow(/database:own-tables/)
    expect(() => defineModule({ manifest: { ...base, permissions: ['database:own-tables'] }, migrations: [{ name: 'bad', sql: '' }] })).toThrow(/0001/)
  })
  test('sorts migrations and returns a parsed manifest', () => {
    const d = defineModule({
      manifest: { ...base, permissions: ['database:own-tables'] },
      migrations: [{ name: '0002_b', sql: 'b' }, { name: '0001_a', sql: 'a' }],
    })
    expect(d.migrations!.map((m) => m.name)).toEqual(['0001_a', '0002_b'])
    expect(d.manifest.edition).toBe('community')
  })
})

describe('settings validation', () => {
  const schema: SettingsSchema = {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string', title: 'Title', minLength: 2, maxLength: 10 },
      mode: { type: 'string', title: 'Mode', enum: ['a', 'b'], default: 'a' },
      limit: { type: 'integer', title: 'Limit', minimum: 1, maximum: 5, default: 3 },
      ratio: { type: 'number', title: 'Ratio' },
      on: { type: 'boolean', title: 'On', default: false },
      token: { type: 'string', title: 'Token', secret: true },
      url: { type: 'string', title: 'URL', format: 'url' },
    },
  }
  test('defaults and happy path', () => {
    expect(settingsDefaults(schema)).toEqual({ mode: 'a', limit: 3, on: false })
    const r = validateSettings(schema, { title: 'Hello', limit: '4', url: 'https://x.test' })
    expect(r.ok).toBe(true)
    expect(r.values).toMatchObject({ title: 'Hello', mode: 'a', limit: 4, on: false, url: 'https://x.test' })
  })
  test('reports field errors', () => {
    const r = validateSettings(schema, { title: 'x', mode: 'z', limit: 9, ratio: 'abc', on: 'yes', url: 'ftp://nope', ghost: 1 })
    expect(r.ok).toBe(false)
    expect(Object.keys(r.errors).sort()).toEqual(['ghost', 'limit', 'mode', 'on', 'ratio', 'title', 'url'])
  })
  test('required is enforced and integer rejects fractions', () => {
    expect(validateSettings(schema, {}).errors.title).toMatch(/required/)
    expect(validateSettings(schema, { title: 'ok', limit: 2.5 }).errors.limit).toMatch(/whole/)
  })
  test('secrets are redacted and the placeholder keeps the stored value', () => {
    const red = redactSettings(schema, { title: 'Hello', token: 's3cret' })
    expect(red.token).toBe(SECRET_PLACEHOLDER)
    const r = validateSettings(schema, { title: 'Hello', token: SECRET_PLACEHOLDER }, { token: 's3cret' })
    expect(r.values.token).toBe('s3cret')
  })
  test('modules without a settings schema accept only empty input', () => {
    expect(validateSettings(undefined, {}).ok).toBe(true)
    expect(validateSettings(undefined, { a: 1 }).ok).toBe(false)
  })
  test('non-object input is rejected', () => {
    expect(validateSettings(schema, 'x').ok).toBe(false)
    expect(validateSettings(schema, [1]).ok).toBe(false)
  })
})

describe('event bus', () => {
  const ev = { issueId: 1, issueKey: 'A-1', projectId: 1 }
  test('delivers to subscribers and unsubscribes', async () => {
    const bus = createEventBus()
    const seen: string[] = []
    const off = bus.on('issue.created', (p) => { seen.push(p.issueKey) })
    await bus.emit('issue.created', ev)
    off()
    await bus.emit('issue.created', ev)
    expect(seen).toEqual(['A-1'])
  })
  test('isolates failing handlers and reports them', async () => {
    const errors: string[] = []
    const bus = createEventBus((_e, i) => { errors.push(i.owner) })
    let ok = false
    bus.on('issue.created', () => { throw new Error('boom') }, 'bad')
    bus.on('issue.created', async () => { ok = true }, 'good')
    await bus.emit('issue.created', ev)
    expect(ok).toBe(true)
    expect(errors).toEqual(['bad'])
  })
  test('offOwner removes all subscriptions of an owner', async () => {
    const bus = createEventBus()
    bus.on('issue.created', () => {}, 'm1')
    bus.on('issue.deleted', () => {}, 'm1')
    bus.on('issue.created', () => {}, 'm2')
    expect(bus.listenerCount()).toBe(3)
    expect(bus.offOwner('m1')).toBe(2)
    expect(bus.listenerCount('issue.created')).toBe(1)
  })
})

describe('module api client', () => {
  test('builds module urls, sends json and maps errors', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/boom')) return new Response(JSON.stringify({ errorMessages: ['Nope'], code: 'X' }), { status: 402 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    const api = createModuleApiClient('demo-app', 'http://api', fake)
    expect(await api.post('/notes', { a: 1 })).toEqual({ ok: true })
    expect(calls[0].url).toBe('http://api/rest/modules/demo-app/notes')
    expect(calls[0].init.body).toBe('{"a":1}')
    await expect(api.get('boom')).rejects.toBeInstanceOf(ModuleApiError)
    await expect(api.get('boom')).rejects.toMatchObject({ status: 402, code: 'X', message: 'Nope' })
  })
})
