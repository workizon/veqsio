import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { TypeDef, Lookups } from '@/lib/workflow-graph'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: options?.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options?.headers,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.join(' ') || (res.status === 403 ? 'System administrator rights are required' : `HTTP ${res.status}`))
  }
  return res.json()
}

const A = '/rest/api/2/admin'

export interface WorkflowSummary {
  id: number
  name: string
  description: string | null
  isDefault: boolean
  transitionCount: number
  schemes: { id: number; name: string }[]
  projects: { id: number; key: string; name: string }[]
}

export interface WfStatus { id: number; name: string; description?: string | null; category: string; color: string; allowNewIssues?: boolean }
export interface WfItem extends Record<string, unknown> { type: string }
export interface WfTransition {
  id: number
  name: string
  fromStatusId: number | null
  toStatusId: number
  screenId: number | null
  conditions: WfItem[]
  validators: WfItem[]
  postFunctions: WfItem[]
  /** plain-language answer to "who may move" computed by the server from the conditions */
  whoMayMove?: string
}
export interface WfWarning { code: string; message: string; statusId?: number }
export interface WorkflowDetail {
  id: number
  name: string
  description: string | null
  isDefault: boolean
  statuses: WfStatus[]
  transitions: WfTransition[]
  positions: Record<string, { x: number; y: number }>
  warnings: WfWarning[]
  schemes: { id: number; name: string }[]
  projects: { id: number; key: string; name: string }[]
}
export interface WorkflowTypes {
  conditions: TypeDef[]
  validators: TypeDef[]
  postFunctions: TypeDef[]
  lookups: Lookups
  categories: string[]
}
export interface AdminStatus extends WfStatus { issueCount: number; transitionCount: number }

export type TransitionInput = Partial<Omit<WfTransition, 'id'>>

export function useAdminWorkflows() {
  return useQuery({ queryKey: ['admin-workflows'], queryFn: () => api<{ workflows: WorkflowSummary[] }>(`${A}/workflow`) })
}

export function useWorkflowDetail(id: number) {
  return useQuery({ queryKey: ['admin-workflow', id], queryFn: () => api<WorkflowDetail>(`${A}/workflow/${id}`), enabled: Number.isFinite(id) })
}

export function useWorkflowTypes() {
  return useQuery({ queryKey: ['admin-workflow-types'], queryFn: () => api<WorkflowTypes>(`${A}/workflow/types`), staleTime: 60_000 })
}

export function useAdminStatuses() {
  return useQuery({ queryKey: ['admin-statuses'], queryFn: () => api<{ statuses: AdminStatus[] }>(`${A}/status`) })
}

export function useWorkflowMutations(workflowId?: number) {
  const qc = useQueryClient()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-workflows'] })
    qc.invalidateQueries({ queryKey: ['workflows'] })
    if (workflowId !== undefined) qc.invalidateQueries({ queryKey: ['admin-workflow', workflowId] })
  }
  const refreshStatuses = () => { qc.invalidateQueries({ queryKey: ['admin-statuses'] }); refresh() }
  return {
    createWorkflow: useMutation({
      mutationFn: (d: { name: string; description?: string; cloneFromId?: number }) =>
        api<{ id: number; name: string }>(`${A}/workflow`, { method: 'POST', body: JSON.stringify(d) }),
      onSuccess: refresh,
    }),
    updateWorkflow: useMutation({
      mutationFn: (d: { id: number; name?: string; description?: string | null }) => {
        const { id, ...rest } = d
        return api<{ id: number }>(`${A}/workflow/${id}`, { method: 'PUT', body: JSON.stringify(rest) })
      },
      onSuccess: refresh,
    }),
    deleteWorkflow: useMutation({
      mutationFn: (id: number) => api<unknown>(`${A}/workflow/${id}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
    saveLayout: useMutation({
      mutationFn: (d: { id: number; nodes: Record<string, { x: number; y: number }> }) =>
        api<unknown>(`${A}/workflow/${d.id}/layout`, { method: 'PUT', body: JSON.stringify({ nodes: d.nodes }) }),
      onSuccess: refresh,
    }),
    addTransition: useMutation({
      mutationFn: (d: TransitionInput & { name: string; toStatusId: number }) =>
        api<{ id: number }>(`${A}/workflow/${workflowId}/transition`, { method: 'POST', body: JSON.stringify(d) }),
      onSuccess: refresh,
    }),
    updateTransition: useMutation({
      mutationFn: (d: { id: number } & TransitionInput) => {
        const { id, ...rest } = d
        return api<{ id: number }>(`${A}/workflow/${workflowId}/transition/${id}`, { method: 'PUT', body: JSON.stringify(rest) })
      },
      onSuccess: refresh,
    }),
    deleteTransition: useMutation({
      mutationFn: (id: number) => api<unknown>(`${A}/workflow/${workflowId}/transition/${id}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
    createStatus: useMutation({
      mutationFn: (d: { name: string; category: string; color?: string; description?: string }) =>
        api<WfStatus>(`${A}/status`, { method: 'POST', body: JSON.stringify(d) }),
      onSuccess: refreshStatuses,
    }),
    updateStatus: useMutation({
      mutationFn: (d: { id: number; name?: string; category?: string; color?: string; allowNewIssues?: boolean }) => {
        const { id, ...rest } = d
        return api<WfStatus>(`${A}/status/${id}`, { method: 'PUT', body: JSON.stringify(rest) })
      },
      onSuccess: refreshStatuses,
    }),
    deleteStatus: useMutation({
      mutationFn: (id: number) => api<unknown>(`${A}/status/${id}`, { method: 'DELETE' }),
      onSuccess: refreshStatuses,
    }),
  }
}
