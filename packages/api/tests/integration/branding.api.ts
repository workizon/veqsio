import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { invalidatePermissionCache } from '../../src/rbac/service'
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db'
import * as schema from '@veqsio/db'
import { eq } from 'drizzle-orm'
import app from '../../src/app'
import { resetRateLimits } from '../reset-rate-limits'
import { clearTestLicense, useTestLicense } from '../test-license'
import { invalidateBranding } from '../../src/branding/store'
import pkg from '../../../../package.json'

describe('Branding and server info', () => {
  let testSql: ReturnType<typeof createTestSql>
  let db: ReturnType<typeof createTestDb>
  let admin = '', bob = ''

  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const upload = (cookie: string, slot: string, bytes: string | Uint8Array, name = 'logo.svg', type = 'image/svg+xml') => {
    const form = new FormData()
    form.append('file', new File([bytes as BlobPart], name, { type }))
    return app.request(`/rest/api/2/admin/branding/logo/${slot}`, { method: 'POST', headers: { Cookie: cookie }, body: form })
  }
  const login = async (username: string) => (await app.request('/rest/auth/1/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pw-123456' }),
  })).headers.get('set-cookie') || ''
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c00"/></svg>'
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

  beforeAll(async () => {
    await resetRateLimits()
    await clearTestLicense()
    testSql = createTestSql()
    const seeded = await seedTestData(testSql)
    db = createTestDb(testSql)
    const bcrypt = await import('bcryptjs')
    const hash = await bcrypt.hash('pw-123456', 4)
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id))
    await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash })
    await testSql`DELETE FROM system_settings WHERE key LIKE 'branding%'`
    invalidateBranding()
    admin = await login('admin')
    bob = await login('bob')
  })

  afterAll(async () => {
    await clearTestLicense()
    await testSql`DELETE FROM system_settings WHERE key LIKE 'branding%'`
    invalidateBranding()
    await resetTestDb(testSql)
    await testSql.end()
  })

  test('serverInfo reports the version from the root package.json and the build id', async () => {
    delete process.env.VEQSIO_BUILD
    const info = await (await app.request('/rest/api/2/serverInfo')).json()
    expect(info.version).toBe(pkg.version)
    expect(info.versionNumbers).toEqual(pkg.version.split('.').map(Number))
    expect(info.build).toBe('dev')
    expect(info.serverTitle).toBeTruthy()
    process.env.VEQSIO_BUILD = '4711'
    const again = await (await app.request('/rest/api/2/serverInfo')).json()
    expect(again.build).toBe('4711')
    expect(again.buildNumber).toBe(4711)
    delete process.env.VEQSIO_BUILD
  })

  test('the public read endpoint needs no login, has defaults and cache headers', async () => {
    const res = await app.request('/rest/api/2/branding')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('max-age')
    const b = await res.json()
    expect(b).toMatchObject({ logoLightUrl: null, logoDarkUrl: null, faviconUrl: null, accentColor: null, supportUrl: null, docsUrl: null, hideCredit: false })
    expect(b.siteName).toBeTruthy()
    expect(b.sourceUrl).toMatch(/^https?:\/\//)
  })

  test('admin endpoints refuse anonymous users and non-administrators', async () => {
    await invalidatePermissionCache() // user ids repeat across suites and the real guard caches grants
    expect((await call('', 'GET', '/rest/api/2/admin/branding')).status).toBe(401)
    expect((await call('', 'PUT', '/rest/api/2/admin/branding', { siteName: 'X' })).status).toBe(401)
    expect((await call(bob, 'GET', '/rest/api/2/admin/branding')).status).toBe(403)
    expect((await call(bob, 'PUT', '/rest/api/2/admin/branding', { siteName: 'X' })).status).toBe(403)
    expect((await upload(bob, 'light', SVG)).status).toBe(403)
    expect((await call(bob, 'DELETE', '/rest/api/2/admin/branding/logo/light')).status).toBe(403)
    expect((await call(bob, 'DELETE', '/rest/api/2/admin/branding')).status).toBe(403)
  })

  test('validates and stores the text settings', async () => {
    expect((await call(admin, 'PUT', '/rest/api/2/admin/branding', { accentColor: 'blue' })).status).toBe(400)
    const light = await call(admin, 'PUT', '/rest/api/2/admin/branding', { accentColor: '#FFEE00' })
    expect(light.status).toBe(400)
    expect((await light.json()).errorMessages[0]).toMatch(/contrast/)
    expect((await call(admin, 'PUT', '/rest/api/2/admin/branding', { supportUrl: 'javascript:alert(1)' })).status).toBe(400)
    expect((await call(admin, 'PUT', '/rest/api/2/admin/branding', { docsUrl: 'ftp://x.example' })).status).toBe(400)
    expect((await call(admin, 'PUT', '/rest/api/2/admin/branding', { siteName: 'x'.repeat(61) })).status).toBe(400)
    expect((await call(admin, 'PUT', '/rest/api/2/admin/branding', { unknown: 1 })).status).toBe(400)

    const ok = await call(admin, 'PUT', '/rest/api/2/admin/branding', { siteName: 'Acme Tracker', accentColor: '#1d4ed8', supportUrl: 'https://help.acme.test/', docsUrl: 'https://docs.acme.test/' })
    expect(ok.status).toBe(200)
    const pub = await (await app.request('/rest/api/2/branding')).json()
    expect(pub).toMatchObject({ siteName: 'Acme Tracker', accentColor: '#1D4ED8', supportUrl: 'https://help.acme.test/', docsUrl: 'https://docs.acme.test/' })
    // serverInfo follows the configured name
    expect((await (await app.request('/rest/api/2/serverInfo')).json()).serverTitle).toBe('Acme Tracker')
  })

  test('images: type, size and content checks; served with hardening headers', async () => {
    expect((await upload(admin, 'nope', SVG)).status).toBe(404)
    expect((await upload(admin, 'light', '<html>hi</html>', 'x.svg')).status).toBe(400)
    expect((await upload(admin, 'light', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).status).toBe(400)
    expect((await upload(admin, 'light', 'GIF89a....', 'x.png', 'image/png')).status).toBe(400)
    expect((await upload(admin, 'light', new Uint8Array(600 * 1024).fill(1), 'big.png', 'image/png')).status).toBe(413)
    const big = new Uint8Array(512 * 1024 + 1); big.set(PNG)
    expect((await upload(admin, 'light', big, 'big.png', 'image/png')).status).toBe(413)
    // ICO only for the favicon
    expect((await upload(admin, 'light', new Uint8Array([0, 0, 1, 0, 1, 0]), 'x.ico', 'image/x-icon')).status).toBe(400)
    expect((await upload(admin, 'favicon', new Uint8Array([0, 0, 1, 0, 1, 0]), 'x.ico', 'image/x-icon')).status).toBe(201)

    const up = await upload(admin, 'light', SVG)
    expect(up.status).toBe(201)
    expect((await upload(admin, 'dark', PNG, 'dark.png', 'image/png')).status).toBe(201)
    const pub = await (await app.request('/rest/api/2/branding')).json()
    expect(pub.logoLightUrl).toMatch(/^\/rest\/api\/2\/branding\/file\/light\?v=[0-9a-f]+$/)
    expect(pub.logoDarkUrl).toMatch(/file\/dark/)
    expect(pub.faviconUrl).toMatch(/file\/favicon/)

    const file = await app.request(pub.logoLightUrl)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('image/svg+xml')
    expect(file.headers.get('x-content-type-options')).toBe('nosniff')
    expect(file.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(await file.text()).toBe(SVG)
    const etag = file.headers.get('etag')!
    const cached = await app.request(pub.logoLightUrl, { headers: { 'If-None-Match': etag } })
    expect(cached.status).toBe(304)
    const png = await app.request('/rest/api/2/branding/file/dark')
    expect(png.headers.get('content-type')).toBe('image/png')
    expect((await app.request('/rest/api/2/branding/file/nope')).status).toBe(404)
  })

  test('a spoofed content type does not matter: the content decides', async () => {
    const res = await upload(admin, 'dark', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'logo.png', 'image/png')
    expect(res.status).toBe(201)
    expect((await app.request('/rest/api/2/branding/file/dark')).headers.get('content-type')).toBe('image/svg+xml')
  })

  test('hiding the credit needs the branding licence (402), showing it again does not', async () => {
    const refused = await call(admin, 'PUT', '/rest/api/2/admin/branding', { hideCredit: true })
    expect(refused.status).toBe(402)
    const body = await refused.json()
    expect(body.feature).toBe('branding')
    expect(body.upgrade.manage).toBe('/admin/license')
    expect((await (await app.request('/rest/api/2/branding')).json()).hideCredit).toBe(false)
    expect((await call(admin, 'PUT', '/rest/api/2/admin/branding', { hideCredit: false })).status).toBe(200)

    await useTestLicense({ plan: 'team' })
    expect((await call(admin, 'PUT', '/rest/api/2/admin/branding', { hideCredit: true })).status).toBe(402)

    await useTestLicense({ plan: 'enterprise' })
    const ok = await call(admin, 'PUT', '/rest/api/2/admin/branding', { hideCredit: true })
    expect(ok.status).toBe(200)
    expect((await (await app.request('/rest/api/2/branding')).json()).hideCredit).toBe(true)
    // the source link is always offered
    expect((await (await app.request('/rest/api/2/branding')).json()).sourceUrl).toMatch(/^https?:\/\//)

    // licence ends: the credit comes back, the stored choice is kept
    await clearTestLicense()
    expect((await (await app.request('/rest/api/2/branding')).json()).hideCredit).toBe(false)
    expect((await (await call(admin, 'GET', '/rest/api/2/admin/branding')).json()).stored.hideCredit).toBe(true)
  })

  test('changes are written to the audit log without image data', async () => {
    await new Promise((r) => setTimeout(r, 200))
    const rows = await testSql`SELECT action, target, details FROM audit_log WHERE action LIKE 'BRANDING%' ORDER BY id`
    const actions = rows.map((r: any) => r.action)
    expect(actions).toContain('BRANDING_UPDATED')
    expect(actions).toContain('BRANDING_FILE_CREATED')
    expect(JSON.stringify(rows)).not.toContain('PHN2Zy')
  })

  test('removing one image and resetting to defaults', async () => {
    const del = await call(admin, 'DELETE', '/rest/api/2/admin/branding/logo/dark')
    expect(del.status).toBe(200)
    expect((await app.request('/rest/api/2/branding/file/dark')).status).toBe(404)
    expect((await (await app.request('/rest/api/2/branding')).json()).logoLightUrl).toBeTruthy()

    const reset = await call(admin, 'DELETE', '/rest/api/2/admin/branding')
    expect(reset.status).toBe(200)
    const pub = await (await app.request('/rest/api/2/branding')).json()
    expect(pub).toMatchObject({ logoLightUrl: null, faviconUrl: null, accentColor: null, supportUrl: null, hideCredit: false })
    expect(pub.siteName).not.toBe('Acme Tracker')
  })
})
