import { Hono } from 'hono'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { checkAttachmentPolicy } from '../settings/instance'
import { uploadFile, getSignedDownloadUrl, isAllowedMimeType, validateFileSize } from '../storage/service'
import { storageConfig } from '../storage/config'
import { loadPortalDesk, loadCustomerRequest, customerSideUserIds } from '../servicedesk/access'
import { portalUploadLimit } from '../servicedesk/limits'
import {
  checkContent, maxAttachmentBytes, normalizeMime, safeExtension, sanitizeFileName, MAX_ATTACHMENTS_PER_REQUEST,
} from '../servicedesk/upload-validation'

/**
 * Customer portal attachments. Authorization is identical to portal comments: only the
 * request's customer or a participant. Customers only ever see files uploaded by the
 * customer side (requester / participants), never files agents attached internally.
 */
const app = new Hono<AppContext>()
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)
const bad = (c: any, msg: string, status: 400 | 413 = 400) => c.json({ errorMessages: [msg] }, status)

const BASE = '/rest/servicedeskapi/portal/:slug/request/:key/attachment'
const MOCK_DIR = () => process.env.MOCK_STORAGE_DIR || '/tmp/veqsio-attachments'

const present = (a: typeof schema.attachments.$inferSelect, slug: string, key: string, userId: number) => ({
  id: a.id,
  filename: a.filename,
  size: Number(a.filesize),
  mimeType: a.mimetype,
  created: a.createdAt,
  mine: a.authorId === userId,
  content: `/rest/servicedeskapi/portal/${slug}/request/${key}/attachment/${a.id}`,
})

/** Visible attachment of this request, or null (also null for files an agent attached). */
async function visibleAttachment(row: NonNullable<Awaited<ReturnType<typeof loadCustomerRequest>>>, id: number) {
  if (!Number.isInteger(id) || id <= 0) return null
  const authors = await customerSideUserIds(row.req)
  const [a] = await db.select().from(schema.attachments)
    .where(and(eq(schema.attachments.id, id), eq(schema.attachments.issueId, row.issue.id), inArray(schema.attachments.authorId, authors))).limit(1)
  return a ?? null
}

app.get(BASE, requireAuth, async (c) => {
  const user = c.get('user')!
  const desk = await loadPortalDesk(user, c.req.param('slug')); if (!desk) return notFound(c)
  const row = await loadCustomerRequest(user, desk, c.req.param('key')); if (!row) return notFound(c)
  const authors = await customerSideUserIds(row.req)
  const rows = await db.select().from(schema.attachments)
    .where(and(eq(schema.attachments.issueId, row.issue.id), inArray(schema.attachments.authorId, authors)))
    .orderBy(desc(schema.attachments.createdAt)).limit(MAX_ATTACHMENTS_PER_REQUEST * 5)
  return c.json({ values: rows.map((a) => present(a, desk.slug, row.issue.issueKey, user.id)) })
})

app.post(BASE, requireAuth, async (c) => {
  const user = c.get('user')!
  const desk = await loadPortalDesk(user, c.req.param('slug')); if (!desk) return notFound(c)
  const row = await loadCustomerRequest(user, desk, c.req.param('key')); if (!row) return notFound(c)
  const limited = await portalUploadLimit(c, desk); if (limited) return limited

  const max = maxAttachmentBytes()
  // Refuse oversized bodies before buffering them (multipart overhead is small).
  const declaredLength = Number(c.req.header('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > max + 64 * 1024) return bad(c, 'File too large', 413)

  const ctype = c.req.header('content-type') ?? ''
  if (!ctype.toLowerCase().startsWith('multipart/form-data')) return bad(c, 'Expected multipart upload')

  let form: FormData
  try { form = await c.req.formData() } catch { return bad(c, 'Invalid upload') }
  const files = form.getAll('file')
  if (files.length !== 1 || !(files[0] instanceof File)) return bad(c, 'Exactly one file is required')
  const file = files[0] as File

  if (file.size <= 0) return bad(c, 'File is empty')
  if (file.size > max || !validateFileSize(file.size)) return bad(c, 'File too large', 413)
  if (!isAllowedMimeType(normalizeMime(file.type) || 'application/octet-stream')) return bad(c, 'File type not allowed')
  const policy = await checkAttachmentPolicy(file.size, file.name, row.issue.projectId)
  if (policy) return bad(c, policy)

  const buf = new Uint8Array(await file.arrayBuffer())
  const check = checkContent(file.type, buf.subarray(0, 512))
  if (!check.ok) return bad(c, check.error)
  if (!isAllowedMimeType(check.mime)) return bad(c, 'File type not allowed')

  const [{ n }] = await db.select({ n: count() }).from(schema.attachments).where(eq(schema.attachments.issueId, row.issue.id))
  if (Number(n) >= MAX_ATTACHMENTS_PER_REQUEST) return bad(c, `Too many attachments (max ${MAX_ATTACHMENTS_PER_REQUEST})`)

  const [project] = await db.select({ key: schema.projects.projectKey }).from(schema.projects).where(eq(schema.projects.id, row.issue.projectId)).limit(1)
  if (!project) return notFound(c)

  const filename = sanitizeFileName(file.name)
  // The storage key uses a generated name; the display name lives only in the database.
  const stored = await uploadFile(project.key, row.issue.issueKey, Buffer.from(buf), `upload.${safeExtension(filename)}`, check.mime)
  const [a] = await db.insert(schema.attachments).values({
    issueId: row.issue.id, filename, filesize: buf.byteLength, mimetype: check.mime, storageKey: stored.storageKey, authorId: user.id,
  }).returning()
  return c.json(present(a, desk.slug, row.issue.issueKey, user.id), 201)
})

app.get(`${BASE}/:id`, requireAuth, async (c) => {
  const user = c.get('user')!
  const desk = await loadPortalDesk(user, c.req.param('slug')); if (!desk) return notFound(c)
  const row = await loadCustomerRequest(user, desk, c.req.param('key')); if (!row) return notFound(c)
  const a = await visibleAttachment(row, Number(c.req.param('id'))); if (!a) return notFound(c)

  let body: BodyInit
  if (storageConfig.type === 'mock') {
    const f = Bun.file(`${MOCK_DIR()}/${a.storageKey}`)
    if (!(await f.exists())) return notFound(c)
    body = f
  } else {
    const r = await fetch(await getSignedDownloadUrl(a.storageKey, 60))
    if (!r.ok || !r.body) return notFound(c)
    body = r.body
  }

  const ascii = a.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return new Response(body, {
    headers: {
      'Content-Type': a.mimetype,
      'Content-Length': String(a.filesize),
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  })
})

export default app
