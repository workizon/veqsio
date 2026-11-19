import { createHash } from 'node:crypto'
import { eq, like } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'
import { hasFeature } from '../license'
import { sourceUrl } from '../version'
import { SLOTS, type BrandingSlot, type ImageKind } from './helpers'

/**
 * Custom branding, kept in `system_settings`: key `branding` holds the text settings as JSON, and
 * `branding.file.<slot>` holds one uploaded image each (base64 plus its detected type and a content hash).
 */
export interface BrandingSettings {
  siteName: string | null
  accentColor: string | null
  supportUrl: string | null
  docsUrl: string | null
  /** The admin asked to hide the "Powered by Veqsio" credit. Only effective while the `branding` feature is licensed. */
  hideCredit: boolean
}

export interface StoredFile { mime: ImageKind['mime']; b64: string; hash: string; size: number }

const KEY = 'branding'
const FILE_PREFIX = 'branding.file.'
export const DEFAULTS: BrandingSettings = { siteName: null, accentColor: null, supportUrl: null, docsUrl: null, hideCredit: false }

let cache: { at: number; settings: BrandingSettings; files: Partial<Record<BrandingSlot, Omit<StoredFile, 'b64'>>> } | null = null
const TTL_MS = 5_000
export function invalidateBranding() { cache = null }

async function upsert(key: string, value: string) {
  const [row] = await db.select({ id: schema.systemSettings.id }).from(schema.systemSettings).where(eq(schema.systemSettings.key, key)).limit(1)
  if (row) await db.update(schema.systemSettings).set({ value, updatedAt: new Date() }).where(eq(schema.systemSettings.id, row.id))
  else await db.insert(schema.systemSettings).values({ key, value })
}

function parseSettings(raw: string | undefined): BrandingSettings {
  try {
    const v = JSON.parse(raw ?? 'null')
    if (v && typeof v === 'object') return { ...DEFAULTS, ...v, hideCredit: v.hideCredit === true }
  } catch { /* corrupt value: defaults */ }
  return { ...DEFAULTS }
}

async function load() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache
  const rows = await db.select().from(schema.systemSettings).where(like(schema.systemSettings.key, `${KEY}%`))
  const files: Partial<Record<BrandingSlot, Omit<StoredFile, 'b64'>>> = {}
  let settings = { ...DEFAULTS }
  for (const r of rows) {
    if (r.key === KEY) settings = parseSettings(r.value ?? '')
    else if (r.key.startsWith(FILE_PREFIX)) {
      const slot = r.key.slice(FILE_PREFIX.length) as BrandingSlot
      if (!SLOTS.includes(slot)) continue
      try { const { b64: _b, ...meta } = JSON.parse(r.value ?? '') as StoredFile; files[slot] = meta } catch { /* skip */ }
    }
  }
  cache = { at: Date.now(), settings, files }
  return cache
}

export async function getBranding() {
  const { settings, files } = await load()
  return { settings, files }
}

export async function saveSettings(patch: Partial<BrandingSettings>) {
  const { settings } = await load()
  await upsert(KEY, JSON.stringify({ ...settings, ...patch }))
  invalidateBranding()
}

export async function saveFile(slot: BrandingSlot, kind: ImageKind, bytes: Uint8Array) {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const file: StoredFile = { mime: kind.mime, b64: Buffer.from(bytes).toString('base64'), hash, size: bytes.length }
  await upsert(FILE_PREFIX + slot, JSON.stringify(file))
  invalidateBranding()
}

export async function readFile(slot: BrandingSlot): Promise<StoredFile | null> {
  const [row] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, FILE_PREFIX + slot)).limit(1)
  if (!row) return null
  try { return JSON.parse(row.value ?? '') as StoredFile } catch { return null }
}

export async function deleteFile(slot: BrandingSlot) {
  await db.delete(schema.systemSettings).where(eq(schema.systemSettings.key, FILE_PREFIX + slot))
  invalidateBranding()
}

export async function resetBranding() {
  await db.delete(schema.systemSettings).where(like(schema.systemSettings.key, `${KEY}%`))
  invalidateBranding()
}

async function fallbackSiteName(): Promise<string> {
  const [row] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, 'site_name')).limit(1)
  return row?.value || process.env.VEQSIO_BRAND_NAME?.trim() || process.env.SITE_NAME || 'Veqsio'
}

/** Logo set by the platform at signup (VEQSIO_BRAND_LOGO_URL, https only); an uploaded logo always wins. */
function envLogo(): string | null {
  const v = (process.env.VEQSIO_BRAND_LOGO_URL ?? '').trim()
  return /^https:\/\//i.test(v) && v.length < 500 ? v : null
}

/** The public view: what the login page and every page need. Contains no secrets. */
export async function publicBranding() {
  const { settings, files } = await load()
  const url = (slot: BrandingSlot) => (files[slot] ? `/rest/api/2/branding/file/${slot}?v=${files[slot]!.hash}` : null)
  return {
    siteName: settings.siteName || (await fallbackSiteName()),
    logoLightUrl: url('light') ?? envLogo(),
    logoDarkUrl: url('dark') ?? envLogo(),
    faviconUrl: url('favicon'),
    accentColor: settings.accentColor,
    supportUrl: settings.supportUrl,
    docsUrl: settings.docsUrl,
    // Stored intent AND licence: when the licence lapses the credit comes back; the stored choice is kept.
    hideCredit: (settings.hideCredit || process.env.VEQSIO_HIDE_CREDIT === '1') && hasFeature('branding'),
    // The source link must stay reachable in all cases (AGPL section 13).
    sourceUrl: sourceUrl(),
  }
}
