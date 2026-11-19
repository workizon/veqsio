import { ENTERPRISE_FEATURES, FEATURE_LABELS, requiredPlan } from './features'
import { getLicenseInfo, getLicenseSource } from './index'
import { countActiveUsers, seatLimit } from './seats'
import { isCloud } from '../cloud/mode'
import type { LicenseInfo } from './verify'

export const EXPIRY_WARNING_DAYS = 30
const DAY_MS = 86_400_000

export type KeyStatus = 'not_set' | 'valid' | 'grace' | 'expired' | 'invalid_signature' | 'key_unknown' | 'invalid'

export function keyStatusOf(l: Pick<LicenseInfo, 'state' | 'reason'>): KeyStatus {
  switch (l.state) {
    case 'none': return 'not_set'
    case 'valid': return 'valid'
    case 'grace': return 'grace'
    case 'expired': return 'expired'
    default:
      if (l.reason === 'bad_signature') return 'invalid_signature'
      if (l.reason === 'unknown_kid') return 'key_unknown'
      return 'invalid'
  }
}

export function daysToExpiry(expiresAt: string | null, now = new Date()): number | null {
  if (!expiresAt) return null
  const t = Date.parse(expiresAt)
  if (Number.isNaN(t)) return null
  return Math.ceil((t - now.getTime()) / DAY_MS)
}

/** Everything the admin page shows. The key itself is never part of it. */
export async function licenseAdminView(now = new Date()) {
  const l = getLicenseInfo()
  const days = daysToExpiry(l.expiresAt, now)
  const limit = seatLimit()
  const inUse = await countActiveUsers()
  const paid = l.state === 'valid' || l.state === 'grace'
  return {
    edition: paid ? 'enterprise' : 'community',
    state: l.state,
    plan: l.plan,
    customer: l.customer,
    licenseId: l.licenseId,
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    graceEndsAt: l.graceEndsAt,
    daysToExpiry: days,
    expiryWarning: paid && ((days !== null && days <= EXPIRY_WARNING_DAYS) || l.state === 'grace'),
    keyStatus: keyStatusOf(l),
    keySource: getLicenseSource(),
    message: l.message,
    features: l.features,
    featureList: ENTERPRISE_FEATURES.map((key) => ({ key, label: FEATURE_LABELS[key], enabled: l.features.includes(key), plan: requiredPlan(key) })),
    enterpriseFeatures: ENTERPRISE_FEATURES,
    seats: seatLimit(),
    cloudManaged: isCloud(),
    seatsEnforced: limit !== null,
    seatsInUse: inUse,
    seatsAvailable: limit === null ? null : Math.max(0, limit - inUse),
  }
}
