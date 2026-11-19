import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || `HTTP ${res.status}`)
  }
  return res.json()
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SSOSettings {
  provider: string
  clientId: string
  clientSecret: string
  tenantId: string
  redirectUri: string
  enforceSso: boolean
  active: boolean
}

/* ------------------------------------------------------------------ */
/*  Queries & Mutations                                                */
/* ------------------------------------------------------------------ */

export function useSSOSettings() {
  return useQuery({
    queryKey: ['sso-settings'],
    queryFn: () => fetchJson<SSOSettings>('/rest/auth/1/sso/settings'),
  })
}

export function useUpdateSSOSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      clientId: string
      clientSecret: string
      tenantId: string
      redirectUri: string
      enforceSso: boolean
      active?: boolean
    }) =>
      fetchJson<SSOSettings>('/rest/auth/1/sso/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sso-settings'] })
    },
  })
}

export function useTestSSOConnection() {
  return useMutation({
    mutationFn: async (data: {
      clientId: string
      clientSecret: string
      tenantId: string
      redirectUri: string
    }) => {
      const res = await fetch('/rest/auth/1/sso/microsoft', {
        method: 'GET',
        credentials: 'include',
        redirect: 'manual',
      })
      // We expect a redirect (302) if SSO is configured
      if (res.status === 302 || res.type === 'opaqueredirect') {
        return { ok: true }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.errorMessages?.[0] || 'Connection test failed')
      }
      return { ok: true }
    },
  })
}
