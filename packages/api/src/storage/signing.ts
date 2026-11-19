import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'

/**
 * Signed, expiring links for the built-in file storage (STORAGE_TYPE=mock), so that a link is a permission that runs out and
 * not a permanent secret: a URL copied into a ticket, an e-mail or a browser history stops working after 15 minutes, and the
 * file cannot be fetched at all by somebody who was never given a link. The key is STORAGE_SIGNING_KEY, else a random one that is
 * created once and kept in system_settings, so that it is the same on every node and after a restart.
 */
let cached: Buffer | null = null

export async function signingKey(): Promise<Buffer> {
  if (cached) return cached
  const env = process.env.STORAGE_SIGNING_KEY
  if (env && env.length >= 16) return (cached = Buffer.from(env))
  const name = 'storage.signing_key'
  const [row] = await db.select({ v: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, name)).limit(1)
  if (row?.v) return (cached = Buffer.from(row.v, 'hex'))
  const fresh = randomBytes(32).toString('hex')
  await db.insert(schema.systemSettings).values({ key: name, value: fresh }).onConflictDoNothing()
  const [again] = await db.select({ v: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, name)).limit(1)
  return (cached = Buffer.from(again?.v ?? fresh, 'hex'))
}
export function resetSigningKeyCacheForTests(): void { cached = null }

export function signatureFor(key: Buffer, storageKey: string, exp: number, inline: boolean): string {
  return createHmac('sha256', key).update(`${storageKey}\n${exp}\n${inline ? 1 : 0}`).digest('hex')
}

export function verifySignature(key: Buffer, storageKey: string, exp: number, inline: boolean, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now || exp * 1000 > now + 7 * 86400_000) return false
  const want = Buffer.from(signatureFor(key, storageKey, exp, inline), 'hex')
  let got: Buffer
  try { got = Buffer.from(sig, 'hex') } catch { return false }
  return got.length === want.length && timingSafeEqual(got, want)
}

/** Avatars are shown to anybody who can see the page, long after an upload: they keep a plain link. */
export function isPublicStorageKey(storageKey: string): boolean {
  return /^attachments\/[^/]+\/avatars\/[^/]+$/.test(storageKey)
}
