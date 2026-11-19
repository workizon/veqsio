import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
    throw new Error(msg)
  }
  return res.json()
}

/** Enabled flags of the switchable core features; unknown ids count as enabled so the UI never hides things by accident. */
export function useFeatures() {
  const q = useQuery({ queryKey: ['features'], queryFn: () => api<{ features: Array<{ id: string; enabled: boolean }> }>('/rest/api/2/features'), staleTime: 60_000 })
  const off = new Set((q.data?.features ?? []).filter((f) => !f.enabled).map((f) => f.id))
  return { isEnabled: (id?: string) => !id || !off.has(id), loaded: !!q.data }
}

export interface AdminFeature { id: string; name: string; description: string; note: string | null; enabled: boolean }
export interface AdminModule { id: string; name: string; version: string; edition: string; description?: string; licensed: boolean; enabled: boolean }

export function useAdminFeatures() {
  return useQuery({ queryKey: ['admin-features'], queryFn: () => api<{ features: AdminFeature[] }>('/rest/api/2/admin/features').then((r) => r.features) })
}
export function useAdminModules() {
  return useQuery({ queryKey: ['admin-modules'], queryFn: () => api<{ modules: AdminModule[] }>('/rest/api/2/modules').then((r) => r.modules) })
}

export function useToggleFeature() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api<unknown>(`/rest/api/2/admin/features/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-features'] }); qc.invalidateQueries({ queryKey: ['features'] }) },
  })
}
export function useToggleModule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api<unknown>(`/rest/api/2/modules/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-modules'] }); qc.invalidateQueries({ queryKey: ['modules'] }) },
  })
}
