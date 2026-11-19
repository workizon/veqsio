import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { isPlan, PLAN_FEATURES, type Plan } from './features'

/**
 * Offline licence verification.
 *
 * Token format:  VQL1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
 * The signature covers the ASCII string "VQL1.<payload>" exactly as transmitted. Only the vendor holds the
 * private key; instances embed public keys (see public-keys.ts), so verification needs no network access.
 */

export interface LicensePayload {
  v: 1
  kid: string
  id: string
  customer: string
  plan: Plan
  features: string[]
  seats?: number
  issuedAt: string
  expiresAt: string | null
  graceDays?: number
  instance?: string
}

export interface PublicKeyEntry { kid: string; pem: string }

export type LicenseState = 'none' | 'valid' | 'grace' | 'expired' | 'invalid'

export interface LicenseInfo {
  state: LicenseState
  plan: Plan
  customer: string | null
  licenseId: string | null
  features: string[]
  seats: number | null
  issuedAt: string | null
  expiresAt: string | null
  graceEndsAt: string | null
  message: string
  /** Why an `invalid` key was rejected (machine readable; never contains the key). */
  reason?: 'malformed' | 'unknown_kid' | 'bad_signature' | 'wrong_instance' | 'bad_date'
}

export const COMMUNITY: LicenseInfo = {
  state: 'none', plan: 'community', customer: null, licenseId: null, features: [], seats: null,
  issuedAt: null, expiresAt: null, graceEndsAt: null, message: 'Community edition (no licence key).',
}

const DAY_MS = 86_400_000
export const DEFAULT_GRACE_DAYS = 14

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function invalid(message: string, reason: NonNullable<LicenseInfo['reason']>): LicenseInfo {
  return { ...COMMUNITY, state: 'invalid', message, reason }
}

/** Pure: decode without trusting. Returns null for malformed tokens. */
export function decodeToken(token: string): { payload: LicensePayload; signed: string; signature: Buffer } | null {
  const parts = token.trim().split('.')
  if (parts.length !== 3 || parts[0] !== 'VQL1') return null
  try {
    const payload = JSON.parse(b64urlToBuffer(parts[1]).toString('utf8')) as LicensePayload
    if (!payload || payload.v !== 1 || typeof payload.kid !== 'string' || !isPlan(payload.plan)) return null
    if (!Array.isArray(payload.features) || payload.features.some((f) => typeof f !== 'string')) return null
    if (typeof payload.customer !== 'string' || typeof payload.id !== 'string' || typeof payload.issuedAt !== 'string') return null
    return { payload, signed: `${parts[0]}.${parts[1]}`, signature: b64urlToBuffer(parts[2]) }
  } catch {
    return null
  }
}

export function verifyLicense(
  token: string | null | undefined,
  keys: readonly PublicKeyEntry[],
  now: Date = new Date(),
  opts: { instanceId?: string } = {},
): LicenseInfo {
  if (!token || !token.trim()) return COMMUNITY
  const decoded = decodeToken(token)
  if (!decoded) return invalid('The licence key is malformed.', 'malformed')
  const { payload, signed, signature } = decoded

  const key = keys.find((k) => k.kid === payload.kid)
  if (!key) return invalid(`The licence key was signed with an unknown key (${payload.kid}).`, 'unknown_kid')

  let ok = false
  try {
    ok = cryptoVerify(null, Buffer.from(signed, 'utf8'), createPublicKey(key.pem), signature)
  } catch {
    ok = false
  }
  if (!ok) return invalid('The licence signature is not valid.', 'bad_signature')

  if (payload.instance && opts.instanceId && payload.instance !== opts.instanceId) {
    return invalid('The licence was issued for a different instance.', 'wrong_instance')
  }

  const issued = Date.parse(payload.issuedAt)
  if (Number.isNaN(issued)) return invalid('The licence has an invalid issue date.', 'bad_date')

  const expires = payload.expiresAt ? Date.parse(payload.expiresAt) : null
  if (payload.expiresAt && Number.isNaN(expires as number)) return invalid('The licence has an invalid expiry date.', 'bad_date')
  const graceDays = Math.min(Math.max(payload.graceDays ?? DEFAULT_GRACE_DAYS, 0), 90)
  const graceEnd = expires === null ? null : expires + graceDays * DAY_MS

  const features = [...new Set([...PLAN_FEATURES[payload.plan], ...payload.features])]
  const base: Omit<LicenseInfo, 'state' | 'message'> = {
    plan: payload.plan,
    customer: payload.customer,
    licenseId: payload.id,
    features,
    seats: typeof payload.seats === 'number' ? payload.seats : null,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    graceEndsAt: graceEnd === null ? null : new Date(graceEnd).toISOString(),
  }

  if (expires === null || now.getTime() <= expires) {
    return { ...base, state: 'valid', message: `Licensed to ${payload.customer} (${payload.plan}).` }
  }
  if (graceEnd !== null && now.getTime() <= graceEnd) {
    return { ...base, state: 'grace', message: `The licence expired on ${payload.expiresAt?.slice(0, 10)}. Enterprise features stay on until ${new Date(graceEnd).toISOString().slice(0, 10)}; renew to avoid interruption.` }
  }
  // Expired for good: fall back to community. Never delete or hide data, only switch paid features off.
  return { ...base, features: [], plan: 'community', state: 'expired', message: `The licence expired on ${payload.expiresAt?.slice(0, 10)}. Paid features are switched off; your data is untouched.` }
}
