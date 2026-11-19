import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { sessionMiddleware, requireAuth, type AppContext } from '../auth/middleware'
import { requireGlobalPermission } from '../rbac/middleware'
import { featureRefusal, hasFeature } from '../license'
import { checkAccentColor, cleanUrl, isSlot, MAX_FILE_BYTES, MIN_CONTRAST_ON_WHITE, sniffImage } from '../branding/helpers'
import { deleteFile, getBranding, publicBranding, readFile, resetBranding, saveFile, saveSettings } from '../branding/store'

const app = new Hono<AppContext>()
app.use('/rest/api/2/admin/branding*', sessionMiddleware)

const admin = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const

/** Public on purpose: the sign-in page needs the name, logo and colour before anyone is authenticated. */
app.get('/rest/api/2/branding', async (c) => {
  const body = await publicBranding()
  c.header('Cache-Control', 'public, max-age=30, must-revalidate')
  return c.json(body)
})

/** Uploaded images are served as plain images only: no scripts can run (CSP), no sniffing, same-origin embedding only through <img>. */
app.get('/rest/api/2/branding/file/:slot', async (c) => {
  const slot = c.req.param('slot')
  if (!isSlot(slot)) return c.json({ errorMessages: ['Not found'] }, 404)
  const file = await readFile(slot)
  if (!file) return c.json({ errorMessages: ['Not found'] }, 404)
  const etag = `"${file.hash}"`
  const headers = {
    'Content-Type': file.mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
  }
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers })
  return new Response(Buffer.from(file.b64, 'base64'), { status: 200, headers })
})

async function adminView() {
  const { settings } = await getBranding()
  const pub = await publicBranding()
  return {
    ...pub,
    // What the admin stored (the public view reports the effective value, which also depends on the licence).
    stored: settings,
    hideCreditLicensed: hasFeature('branding'),
    limits: { maxFileBytes: MAX_FILE_BYTES, minAccentContrast: MIN_CONTRAST_ON_WHITE },
  }
}

app.get('/rest/api/2/admin/branding', ...admin, async (c) => c.json(await adminView()))

const nullableText = (max: number) => z.string().trim().max(max).nullable()
const putSchema = z.object({
  siteName: nullableText(60).optional(),
  accentColor: z.string().nullable().optional(),
  supportUrl: z.string().nullable().optional(),
  docsUrl: z.string().nullable().optional(),
  hideCredit: z.boolean().optional(),
}).strict()

app.put('/rest/api/2/admin/branding', ...admin, zValidator('json', putSchema, (r, c) => {
  if (!r.success) return c.json({ errorMessages: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) }, 400)
}), async (c) => {
  const body = c.req.valid('json')
  const patch: Record<string, unknown> = {}
  const errors: string[] = []
  if (body.siteName !== undefined) patch.siteName = body.siteName || null
  if (body.accentColor !== undefined) {
    if (!body.accentColor) patch.accentColor = null
    else {
      const err = checkAccentColor(body.accentColor)
      if (err) errors.push(err); else patch.accentColor = body.accentColor.toUpperCase()
    }
  }
  for (const k of ['supportUrl', 'docsUrl'] as const) {
    if (body[k] === undefined) continue
    const u = cleanUrl(body[k])
    if (u === undefined) errors.push(`${k === 'supportUrl' ? 'Support' : 'Documentation'} URL must be an http(s) address of at most 500 characters`)
    else patch[k] = u
  }
  if (errors.length) return c.json({ errorMessages: errors }, 400)
  // Hiding the credit is the one licensed part of branding; showing it again is always allowed.
  if (body.hideCredit === true && !hasFeature('branding')) return c.json(featureRefusal('branding'), 402)
  if (body.hideCredit !== undefined) patch.hideCredit = body.hideCredit
  await saveSettings(patch)
  return c.json(await adminView())
})

app.post('/rest/api/2/admin/branding/logo/:slot', ...admin, async (c) => {
  const slot = c.req.param('slot')
  if (!isSlot(slot)) return c.json({ errorMessages: ['Unknown image slot (use light, dark or favicon)'] }, 404)
  const declared = Number(c.req.header('content-length'))
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES + 64 * 1024) return c.json({ errorMessages: [`The file is too large (maximum ${MAX_FILE_BYTES / 1024} KB)`] }, 413)
  const form = await c.req.parseBody().catch(() => null)
  const file = form?.file
  if (!(file instanceof File)) return c.json({ errorMessages: ['Upload the image as multipart/form-data in the field "file"'] }, 400)
  if (file.size > MAX_FILE_BYTES) return c.json({ errorMessages: [`The file is too large (maximum ${MAX_FILE_BYTES / 1024} KB)`] }, 413)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const checked = sniffImage(bytes, slot)
  if (!checked.ok) return c.json({ errorMessages: [checked.error] }, 400)
  await saveFile(slot, checked.kind, bytes)
  return c.json(await adminView(), 201)
})

app.delete('/rest/api/2/admin/branding/logo/:slot', ...admin, async (c) => {
  const slot = c.req.param('slot')
  if (!isSlot(slot)) return c.json({ errorMessages: ['Unknown image slot (use light, dark or favicon)'] }, 404)
  await deleteFile(slot)
  return c.json(await adminView())
})

/** Reset to default: removes every branding setting and image. */
app.delete('/rest/api/2/admin/branding', ...admin, async (c) => {
  await resetBranding()
  return c.json(await adminView())
})

export default app
