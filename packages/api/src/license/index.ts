import { readFileSync } from 'node:fs'
import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'
import { featureLabel, isEnterpriseFeature, requiredPlan, requiredPlanLabel } from './features'
import { configuredPublicKeys } from './public-keys'
import { COMMUNITY, verifyLicense, type LicenseInfo, type PublicKeyEntry } from './verify'

export type { LicenseInfo } from './verify'
export { ENTERPRISE_FEATURES, isEnterpriseFeature } from './features'

const SETTING_KEY = 'license.key'
const REFRESH_MS = 60_000

let current: LicenseInfo = COMMUNITY
let source: 'environment' | 'database' | 'none' = 'none'
let loadedAt = 0
let keysOverride: PublicKeyEntry[] | null = null
let timer: ReturnType<typeof setInterval> | null = null

/** Tests only: replace the trusted public keys. */
export function setLicensePublicKeysForTests(keys: PublicKeyEntry[] | null): void {
  keysOverride = keys
}

function trustedKeys(): PublicKeyEntry[] {
  return keysOverride ?? configuredPublicKeys()
}

function tokenFromEnvironment(): string | null {
  const direct = process.env.VEQSIO_LICENSE_KEY
  if (direct?.trim()) return direct.trim()
  const file = process.env.VEQSIO_LICENSE_FILE
  if (file) {
    try { return readFileSync(file, 'utf8').trim() } catch { /* unreadable: fall through to the database */ }
  }
  return null
}

async function tokenFromDatabase(): Promise<string | null> {
  try {
    const rows = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, SETTING_KEY)).limit(1)
    return rows[0]?.value ?? null
  } catch {
    return null
  }
}

/** Re-reads the key (environment, file, then database) and verifies it. Safe to call often. */
export async function refreshLicense(now = new Date()): Promise<LicenseInfo> {
  const envToken = tokenFromEnvironment()
  const token = envToken ?? (await tokenFromDatabase())
  source = envToken ? 'environment' : token ? 'database' : 'none'
  current = verifyLicense(token, trustedKeys(), now, { instanceId: process.env.VEQSIO_INSTANCE_ID })
  loadedAt = now.getTime()
  return current
}

/** Call once at startup; keeps the cached state fresh so `hasFeature` can stay synchronous. */
export async function initLicense(): Promise<LicenseInfo> {
  const info = await refreshLicense()
  if (!timer) {
    timer = setInterval(() => { refreshLicense().catch(() => {}) }, REFRESH_MS)
    ;(timer as { unref?: () => void }).unref?.()
  }
  return info
}

export function getLicenseInfo(): LicenseInfo {
  return current
}

/** Where the active key comes from. An environment/file key wins over the one saved in the admin UI. */
export function getLicenseSource(): 'environment' | 'database' | 'none' {
  return source
}

/** Synchronous gate. Community features are always on; enterprise features need a licence that includes them. */
export function hasFeature(feature: string): boolean {
  if (!isEnterpriseFeature(feature)) return true
  return current.features.includes(feature)
}

/** Stores a new key after verifying it. Returns the resulting state; an invalid key is NOT stored. */
export async function installLicenseKey(token: string): Promise<LicenseInfo> {
  const info = verifyLicense(token, trustedKeys(), new Date(), { instanceId: process.env.VEQSIO_INSTANCE_ID })
  if (info.state === 'invalid' || info.state === 'none') return info
  const existing = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, SETTING_KEY)).limit(1)
  if (existing.length) await db.update(schema.systemSettings).set({ value: token.trim(), updatedAt: new Date() }).where(eq(schema.systemSettings.id, existing[0].id))
  else await db.insert(schema.systemSettings).values({ key: SETTING_KEY, value: token.trim() })
  return refreshLicense()
}

export async function removeLicenseKey(): Promise<LicenseInfo> {
  await db.delete(schema.systemSettings).where(eq(schema.systemSettings.key, SETTING_KEY))
  return refreshLicense()
}

/** Body for a refused feature, shared by the REST gate and the UI. Never contains the key. */
export function featureRefusal(feature: string) {
  return {
    errorMessages: [`${featureLabel(feature)} requires a Veqsio ${requiredPlanLabel(feature)} licence.`],
    feature,
    licence: current.state,
    upgrade: { plan: requiredPlan(feature), manage: '/admin/license', message: 'Apply a licence key under Admin > Licence, or contact your Veqsio vendor.' },
  }
}

/** Route guard: answers 402 with a clear message and an `upgrade` hint when the feature is not licensed. */
export function requireFeature(feature: string) {
  return createMiddleware(async (c, next) => {
    if (!hasFeature(feature)) return c.json(featureRefusal(feature), 402)
    await next()
  })
}

export function licenseLoadedAt(): number {
  return loadedAt
}
