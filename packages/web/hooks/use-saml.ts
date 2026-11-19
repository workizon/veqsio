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

export interface CertInfo { subject: string; validFrom: string; validTo: string; fingerprint256: string; expired: boolean }

export interface SamlProvider {
  id: number
  name: string
  slug: string
  idpEntityId: string
  idpSsoUrl: string
  idpCertificates: string
  certificates: (CertInfo | null)[]
  signRequests: boolean
  hasSigningKey: boolean
  spSigningCertificate: string | null
  nameIdFormat: string
  emailAttribute: string | null
  displayNameAttribute: string | null
  usernameAttribute: string | null
  groupsAttribute: string | null
  syncGroups: boolean
  defaultGroups: string[]
  allowedDomains: string[]
  autoProvision: boolean
  linkByEmail: boolean
  enforceSso: boolean
  enabled: boolean
  sp: { entityId: string; acsUrl: string; metadataUrl: string; loginUrl: string }
}

export function usePublicSamlProviders() {
  return useQuery({
    queryKey: ['saml-public-providers'],
    queryFn: () => fetchJson<{ name: string; slug: string }[]>('/rest/auth/1/saml/providers'),
    staleTime: 60_000,
  })
}

export function useSamlProviders() {
  return useQuery({ queryKey: ['saml-providers'], queryFn: () => fetchJson<SamlProvider[]>('/rest/api/2/admin/saml') })
}

export function useSaveSamlProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { id?: number; data: Record<string, unknown> }) =>
      p.id ? fetchJson<SamlProvider>(`/rest/api/2/admin/saml/${p.id}`, json('PUT', p.data)) : fetchJson<SamlProvider>('/rest/api/2/admin/saml', json('POST', p.data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saml-providers'] }),
  })
}

export function useDeleteSamlProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => fetchJson<void>(`/rest/api/2/admin/saml/${id}`, json('DELETE')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saml-providers'] }),
  })
}

export function useTestSamlProvider() {
  return useMutation({
    mutationFn: (id: number) => fetchJson<{ ok: boolean; problems: string[]; certificates: (CertInfo | null)[] }>(`/rest/api/2/admin/saml/${id}/test`, json('POST')),
  })
}
