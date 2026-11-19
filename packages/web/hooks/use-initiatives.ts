import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { InitiativeStatus } from '@/lib/initiatives'
import type { StatusUpdate } from '@/lib/status-updates'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
    throw new Error(msg)
  }
  return res.json()
}

export interface Progress { total: number; done: number; inProgress: number; todo: number; cancelled: number; percentDone: number; issueCount: number }
export interface Initiative {
  id: number; name: string; description: string; status: InitiativeStatus; statusLabel: string
  startDate: string | null; targetDate: string | null
  owner: { id: number; displayName: string } | null
  canManage: boolean; progress: Progress; projectCount: number; epicCount: number
  health?: StatusUpdate | null
  projects?: Array<{ key: string; name: string; progress: Progress }>
  epics?: Array<{ key: string; summary: string; status: string; project: { key: string; name: string }; progress: Progress }>
}

export function useInitiatives(enabled = true) {
  return useQuery({ queryKey: ['initiatives'], enabled, queryFn: () => api<{ initiatives: Initiative[] }>('/rest/api/2/initiatives').then((r) => r.initiatives) })
}

export function useInitiative(id: number | string) {
  return useQuery({ queryKey: ['initiatives', String(id)], enabled: !!id, queryFn: () => api<Initiative>(`/rest/api/2/initiatives/${id}`) })
}

function useInvalidating<T>(fn: (v: T) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => { qc.invalidateQueries({ queryKey: ['initiatives'] }); qc.invalidateQueries({ queryKey: ['status-updates'] }) } })
}

export type InitiativeInput = { name: string; description?: string; status?: InitiativeStatus; startDate?: string | null; targetDate?: string | null }

export const useCreateInitiative = () => useInvalidating((v: InitiativeInput) => api<Initiative>('/rest/api/2/initiatives', { method: 'POST', body: JSON.stringify(v) }))
export const useUpdateInitiative = (id: number) => useInvalidating((v: Partial<InitiativeInput>) => api<Initiative>(`/rest/api/2/initiatives/${id}`, { method: 'PUT', body: JSON.stringify(v) }))
export const useDeleteInitiative = (id: number) => useInvalidating((_: void) => api<unknown>(`/rest/api/2/initiatives/${id}`, { method: 'DELETE' }))
export const useLinkInitiative = (id: number) => useInvalidating((v: { projectKey?: string; issueKey?: string }) => api<Initiative>(`/rest/api/2/initiatives/${id}/links`, { method: 'POST', body: JSON.stringify(v) }))
export const useUnlinkInitiative = (id: number) => useInvalidating((v: { kind: 'projects' | 'epics'; key: string }) => api<unknown>(`/rest/api/2/initiatives/${id}/${v.kind}/${encodeURIComponent(v.key)}`, { method: 'DELETE' }))
