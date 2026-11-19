import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import { outboundFetch } from '../../security/outbound'
import { uploadFile } from '../../storage/service'
import type { JiraClient } from './client'

/** Pictures of people and projects, copied so that they do not depend on the old Jira staying up (or on its login). */

const MAX_BYTES = 2 * 1024 * 1024
const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** The avatar URL worth copying: Jira's own generated placeholders (initials, default icons) say nothing, and are drawn here anyway. */
export function usableAvatarUrl(avatarUrls: Record<string, string> | undefined | null): string | null {
  const url = avatarUrls?.['48x48'] ?? avatarUrls?.['32x32'] ?? avatarUrls?.['24x24'] ?? Object.values(avatarUrls ?? {})[0]
  if (!url || typeof url !== 'string') return null
  if (!/^https?:\/\//i.test(url)) return null
  if (/initials|default/i.test(url)) return null
  return url
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { await reader.cancel(); return Buffer.alloc(0) }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

export async function downloadImage(client: Pick<JiraClient, 'download'> & { baseUrl: string }, url: string): Promise<{ bytes: Buffer; mime: string; ext: string } | null> {
  const sameHost = (() => { try { return new URL(url).origin === new URL(client.baseUrl).origin } catch { return false } })()
  let bytes: Buffer
  let mime = ''
  if (sameHost) {
    bytes = await client.download(url, MAX_BYTES)
    mime = sniff(bytes)
  } else {
    const res = await outboundFetch(url, { headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    const declared = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const declaredLength = Number(res.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) { await res.body?.cancel(); return null }
    bytes = await readCapped(res, MAX_BYTES)
    mime = TYPES[declared] ? declared : sniff(bytes)
  }
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null
  if (!TYPES[mime]) return null
  return { bytes, mime, ext: TYPES[mime] }
}

/** The type from the first bytes, because Jira and its image hosts do not always say it right (and SVG, which can carry script, is never accepted). */
export function sniff(b: Buffer): string {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 6 && b.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return ''
}

export interface AvatarReport { users: number; projects: number; failed: number }

/** Copies the avatars of the given users (only those without one) and of one project. */
export async function copyUserAvatars(client: Pick<JiraClient, 'download'> & { baseUrl: string }, sources: Map<number, string>, report: AvatarReport): Promise<void> {
  for (const [userId, url] of sources) {
    try {
      const [u] = await db.select({ avatarUrl: schema.users.avatarUrl }).from(schema.users).where(eq(schema.users.id, userId)).limit(1)
      if (!u || u.avatarUrl) continue
      const img = await downloadImage(client, url)
      if (!img) { report.failed++; continue }
      const up = await uploadFile('users', 'avatars', img.bytes, `avatar-${userId}.${img.ext}`, img.mime)
      await db.update(schema.users).set({ avatarUrl: up.publicUrl }).where(and(eq(schema.users.id, userId), isNull(schema.users.avatarUrl)))
      report.users++
    } catch { report.failed++ }
  }
}

export async function copyProjectAvatar(client: Pick<JiraClient, 'download'> & { baseUrl: string }, projectId: number, projectKey: string, avatarUrls: Record<string, string> | undefined, report: AvatarReport): Promise<void> {
  const url = usableAvatarUrl(avatarUrls)
  if (!url) return
  try {
    const [p] = await db.select({ avatarUrl: schema.projects.avatarUrl }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)
    if (!p || p.avatarUrl) return
    const img = await downloadImage(client, url)
    if (!img) { report.failed++; return }
    const up = await uploadFile(projectKey, 'avatars', img.bytes, `avatar.${img.ext}`, img.mime)
    await db.update(schema.projects).set({ avatarUrl: up.publicUrl }).where(and(eq(schema.projects.id, projectId), isNull(schema.projects.avatarUrl)))
    report.projects++
  } catch { report.failed++ }
}
