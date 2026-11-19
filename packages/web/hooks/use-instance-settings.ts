import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join('. ') || msg } catch {}
    throw new Error(msg)
  }
  return res.json()
}

export interface PublicSettings { defaultLanguage?: string; maintenance?: { message: string } | null; announcement: { level: 'info' | 'warning' | 'critical'; message: string } | null; passwordMinLength: number; publicProjects?: boolean; issueTerm?: 'issue' | 'work item' | 'ticket' | 'task'; demo?: { resetEveryMinutes: number } | null; /** managed Veqsio Cloud tenant: self-host-only pages are hidden (and refused by the API) */ cloud?: boolean }

export function usePublicSettings() {
  return useQuery({ queryKey: ['settings', 'public'], queryFn: () => api<PublicSettings>('/rest/api/2/settings/public'), staleTime: 60_000 })
}

export interface SettingDef {
  key: string; group: string; label: string; description: string; type: 'int' | 'bool' | 'text' | 'list' | 'enum'
  min?: number; max?: number; maxLength?: number; options?: string[]; value: number | boolean | string | string[]
}

export function useAdminSettings() {
  return useQuery({ queryKey: ['admin-settings'], queryFn: () => api<{ settings: SettingDef[] }>('/rest/api/2/admin/settings').then((r) => r.settings) })
}

export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<unknown>('/rest/api/2/admin/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-settings'] }); qc.invalidateQueries({ queryKey: ['settings', 'public'] }) },
  })
}
