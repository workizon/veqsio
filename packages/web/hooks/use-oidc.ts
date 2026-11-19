import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || data.issues?.[0]?.message || `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export interface OidcProvider {
  id: number
  name: string
  slug: string
  issuer: string
  clientId: string
  hasSecret: boolean
  scopes: string
  emailClaim: string
  nameClaim: string
  groupsClaim: string | null
  allowedDomains: string[]
  autoProvision: boolean
  linkByEmail: boolean
  enforceSso: boolean
  enabled: boolean
}

export type OidcProviderInput = Omit<OidcProvider, 'id' | 'hasSecret'> & { clientSecret?: string }

export function usePublicOidcProviders() {
  return useQuery({
    queryKey: ['oidc-public-providers'],
    queryFn: () => fetchJson<{ name: string; slug: string }[]>('/rest/auth/1/oidc/providers'),
    staleTime: 60_000,
  })
}

export function useOidcProviders() {
  return useQuery({
    queryKey: ['oidc-providers'],
    queryFn: () => fetchJson<OidcProvider[]>('/rest/api/2/admin/oidc'),
  })
}

export function useSaveOidcProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { id?: number; data: Partial<OidcProviderInput> & { slug?: string } }) =>
      p.id
        ? fetchJson<OidcProvider>(`/rest/api/2/admin/oidc/${p.id}`, json('PUT', p.data))
        : fetchJson<OidcProvider>('/rest/api/2/admin/oidc', json('POST', p.data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['oidc-providers'] }),
  })
}

export function useDeleteOidcProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => fetchJson<void>(`/rest/api/2/admin/oidc/${id}`, json('DELETE')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['oidc-providers'] }),
  })
}

export function useTestOidcProvider() {
  return useMutation({
    mutationFn: (id: number) => fetchJson<{ ok: boolean; error?: string }>(`/rest/api/2/admin/oidc/${id}/test`, json('POST')),
  })
}

/* ---- SCIM tokens ---- */

export interface ScimToken {
  id: number
  name: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export function useScimTokens() {
  return useQuery({
    queryKey: ['scim-tokens'],
    queryFn: () => fetchJson<ScimToken[]>('/rest/api/2/admin/scim/tokens'),
  })
}

export function useCreateScimToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => fetchJson<ScimToken & { token: string }>('/rest/api/2/admin/scim/tokens', json('POST', { name })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scim-tokens'] }),
  })
}

export function useRevokeScimToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => fetchJson<void>(`/rest/api/2/admin/scim/tokens/${id}`, json('DELETE')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scim-tokens'] }),
  })
}
