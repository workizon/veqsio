import type { LicenseStatus } from '@/hooks/use-license'

export interface LicenceNotice { level: 'warning' | 'critical'; message: string }
const DAY = 86_400_000

/** What an administrator should be told about the licence, or null when all is well (no key at all is the free edition: no notice). */
export function licenceNotice(s: Pick<LicenseStatus, 'state' | 'expiresAt'> | undefined, now = Date.now()): LicenceNotice | null {
  if (!s) return null
  const exp = s.expiresAt ? Date.parse(s.expiresAt) : NaN
  if (s.state === 'expired') return { level: 'critical', message: 'The licence has expired: paid features are switched off. Your data is untouched. Apply a new key under Administration → Licence.' }
  if (s.state === 'grace') return { level: 'warning', message: 'The licence has expired and is in its grace period: paid features still work for now. Renew it under Administration → Licence.' }
  if (s.state === 'invalid') return { level: 'critical', message: 'The licence key is not valid. Check it under Administration → Licence.' }
  if (s.state === 'valid' && Number.isFinite(exp)) {
    const days = Math.ceil((exp - now) / DAY)
    if (days <= 30) return { level: 'warning', message: days <= 0 ? 'The licence expires today. Renew it under Administration → Licence.' : `The licence expires in ${days} day${days === 1 ? '' : 's'}. Renew it under Administration → Licence.` }
  }
  return null
}
