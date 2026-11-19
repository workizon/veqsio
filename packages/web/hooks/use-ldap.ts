import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { SyncCounts } from '@/lib/sso-forms'

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

export interface SyncResult {
  ok: boolean
  dryRun: boolean
  error?: string
  counts?: SyncCounts
  skipped?: { key: string; reason: string }[]
  groupsToCreate?: string[]
  at: string
}

export interface LdapDirectory {
  id: number
  name: string
  url: string
  startTls: boolean
  tlsRejectUnauthorized: boolean
  bindDn: string
  hasBindPassword: boolean
  baseDn: string
  userFilter: string
  usernameAttribute: string
  emailAttribute: string
  displayNameAttribute: string
  uniqueIdAttribute: string
  groupBaseDn: string | null
  groupFilter: string
  groupNameAttribute: string
  groupMemberAttribute: string
  nestedGroups: boolean
  loginEnabled: boolean
  autoProvision: boolean
  linkByEmail: boolean
  syncEnabled: boolean
  syncIntervalMinutes: number
  deactivateMissing: boolean
  maxEntries: number
  timeoutMs: number
  enabled: boolean
  lastSyncAt: string | null
  lastSyncResult: SyncResult | null
  syncRunning: boolean
}

export function useLdapDirectories() {
  return useQuery({ queryKey: ['ldap-directories'], queryFn: () => fetchJson<LdapDirectory[]>('/rest/api/2/admin/ldap') })
}

export function useSaveLdapDirectory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { id?: number; data: Record<string, unknown> }) =>
      p.id ? fetchJson<LdapDirectory>(`/rest/api/2/admin/ldap/${p.id}`, json('PUT', p.data)) : fetchJson<LdapDirectory>('/rest/api/2/admin/ldap', json('POST', p.data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ldap-directories'] }),
  })
}

export function useDeleteLdapDirectory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => fetchJson<void>(`/rest/api/2/admin/ldap/${id}`, json('DELETE')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ldap-directories'] }),
  })
}

export function useTestLdapDirectory() {
  return useMutation({
    mutationFn: (id: number) => fetchJson<{ ok: boolean; error?: string; users?: number; groups?: number | null; truncated?: boolean }>(`/rest/api/2/admin/ldap/${id}/test`, json('POST')),
  })
}

export function useSyncLdapDirectory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { id: number; dryRun: boolean; force?: boolean }) =>
      fetchJson<SyncResult>(`/rest/api/2/admin/ldap/${p.id}/sync`, json('POST', { dryRun: p.dryRun, force: p.force ?? false })),
    onSuccess: (_r, v) => { if (!v.dryRun) qc.invalidateQueries({ queryKey: ['ldap-directories'] }) },
  })
}
