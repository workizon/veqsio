import { useQuery } from '@tanstack/react-query'

export interface LicenseStatus {
  state: 'none' | 'valid' | 'grace' | 'expired' | 'invalid'
  plan: 'community' | 'team' | 'enterprise'
  features: string[]
  expiresAt: string | null
}

/** What this instance is licensed for. Any signed-in user may ask; used to hide or explain gated features. */
export function useLicenseStatus(enabled = true) {
  return useQuery({
    queryKey: ['license', 'status'],
    queryFn: async () => {
      const res = await fetch('/rest/api/2/license/status', { credentials: 'include' })
      if (!res.ok) throw new Error(res.statusText)
      return (await res.json()) as LicenseStatus
    },
    staleTime: 60_000,
    enabled,
    retry: false,
  })
}

export function hasLicensedFeature(status: LicenseStatus | undefined, feature: string): boolean {
  if (!status) return false
  return (status.state === 'valid' || status.state === 'grace') && status.features.includes(feature)
}
