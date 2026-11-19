import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join('. ') || msg } catch { /* keep status text */ }
    throw new Error(msg)
  }
  return res.json()
}

const enc = encodeURIComponent

/* ---- time in status ---- */

export interface TimeInStatusSegment {
  status: string; category: string; enteredAt: string; leftAt: string | null; durationMs: number
  movedBy: { id: number; displayName: string } | null
}
export interface TimeInStatusResponse {
  issueKey: string; totalMs: number
  byStatus: Array<{ status: string; category: string; durationMs: number; visits: number }>
  byCategory: Array<{ category: string; durationMs: number }>
  segments: TimeInStatusSegment[]
}

export function useTimeInStatus(key: string, enabled = true) {
  return useQuery({ queryKey: ['issue', key, 'time-in-status'], enabled: !!key && enabled, queryFn: () => api<TimeInStatusResponse>(`/rest/api/2/issue/${enc(key)}/time-in-status`) })
}

export interface AverageStatusRow { status: string; category: string; issues: number; visits: number; totalMs: number; avgMs: number }
export interface TimeInStatusReport {
  scope: { type: 'project' | 'board' | 'sprint'; id: number | string; name: string }
  issueCount: number; truncated: boolean
  statuses: AverageStatusRow[]
  categories: Array<{ category: string; issues: number; totalMs: number; avgMs: number }>
}

export function useTimeInStatusReport(scope: { project?: string; boardId?: string; sprintId?: string }) {
  const q = scope.sprintId ? `sprintId=${enc(scope.sprintId)}` : scope.boardId ? `boardId=${enc(scope.boardId)}` : scope.project ? `project=${enc(scope.project)}` : ''
  return useQuery({ queryKey: ['reports', 'time-in-status', q], enabled: !!q, retry: false, queryFn: () => api<TimeInStatusReport>(`/rest/api/2/reports/time-in-status?${q}`) })
}

/* ---- description versions ---- */

export interface DescriptionVersionItem {
  version: number; createdAt: string | null; current: boolean; author: { id: number; displayName: string } | null
  length: number; added: number | null; removed: number | null
}
export interface DiffOp { type: 'eq' | 'add' | 'del'; text: string }
export interface DescriptionVersionDetail {
  version: number; createdAt: string | null; current: boolean; author: { id: number; displayName: string } | null
  text: string; diffFromPrevious: DiffOp[] | null; diffToCurrent: DiffOp[] | null
}

export function useDescriptionVersions(key: string, enabled: boolean) {
  return useQuery({ queryKey: ['issue', key, 'description-history'], enabled: !!key && enabled, queryFn: () => api<{ versions: DescriptionVersionItem[] }>(`/rest/api/2/issue/${enc(key)}/description-history`) })
}

export function useDescriptionVersion(key: string, version: number | null) {
  return useQuery({ queryKey: ['issue', key, 'description-history', version], enabled: !!key && version !== null, queryFn: () => api<DescriptionVersionDetail>(`/rest/api/2/issue/${enc(key)}/description-history/${version}`) })
}

export function useRestoreDescription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, version }: { key: string; version: number }) => api<{ restoredVersion: number; newVersion: number }>(`/rest/api/2/issue/${enc(key)}/description-history/${version}/restore`, { method: 'POST' }),
    onSuccess: (_, v) => {
      qc.invalidateQueries({ queryKey: ['issue', v.key] })
      qc.invalidateQueries({ queryKey: ['issues'] })
    },
  })
}

/* ---- type switch ---- */

export interface TypeChangePlan {
  preview: boolean; issueKey: string
  from: { id: number; name: string; subtask: boolean }; to: { id: number; name: string; subtask: boolean }
  droppedFields: Array<{ id: string; name: string; value: string }>
  workflow: { id: number | null; name: string | null; changed: boolean }
  status: {
    current: { id: number; name: string }; needsMapping: boolean; target: { id: number; name: string } | null
    suggestedStatusId: number | null; available: Array<{ id: number; name: string; category: string }>
  }
  parent: { current: string | null; after: string | null; cleared: boolean; required: boolean }
  newDescription: string | null; warnings: string[]; blockers: string[]; canApply: boolean
}
export interface TypeChangeInput { issueTypeId: number; statusId?: number; parentKey?: string }

export function useTypeChangePreview() {
  return useMutation({
    mutationFn: ({ key, input }: { key: string; input: TypeChangeInput }) =>
      api<TypeChangePlan>(`/rest/api/2/issue/${enc(key)}/change-type?preview=true`, { method: 'POST', body: JSON.stringify(input) }),
  })
}

export function useApplyTypeChange() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, input }: { key: string; input: TypeChangeInput }) =>
      api<TypeChangePlan>(`/rest/api/2/issue/${enc(key)}/change-type`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (_, v) => {
      qc.invalidateQueries({ queryKey: ['issue', v.key] })
      qc.invalidateQueries({ queryKey: ['issues'] })
    },
  })
}

/* ---- workflow governance ---- */

export interface WorkflowChangeEntry {
  id: number; at: string; actor: { id: number; name: string } | null
  targetType: string; action: string; summary: string
}

export function useWorkflowHistory(workflowId: number | null) {
  return useQuery({ queryKey: ['admin', 'workflow', workflowId, 'history'], enabled: workflowId !== null, queryFn: () => api<{ entries: WorkflowChangeEntry[] }>(`/rest/api/2/admin/workflow/${workflowId}/history`).then((r) => r.entries) })
}

export function useProjectWorkflowScheme(projectKey: string) {
  return useQuery({ queryKey: ['project', projectKey, 'workflow-scheme'], enabled: !!projectKey, queryFn: () => api<{ scheme: { id: number; name: string } | null; governance: 'any' | 'constrained'; canChange: boolean }>(`/rest/api/2/project/${enc(projectKey)}/workflow-scheme`) })
}

/* ------------------------------ move to another project ------------------------------ */

export interface MovePlan {
  issueKey: string
  from: { project: { key: string; name: string }; type: { id: number; name: string } }
  to: { project: { key: string; name: string }; type: { id: number; name: string } }
  workflow: { from: { id: number; name: string } | null; to: { id: number; name: string } | null; changed: boolean }
  status: { current: { id: number; name: string }; needsMapping: boolean; target: { id: number; name: string } | null; suggestedStatusId: number | null; available: Array<{ id: number; name: string; category: string }> }
  allowedTypes: Array<{ id: number; name: string }>
  droppedFields: Array<{ id: string; name: string; value: string }>
  removed: { components: string[]; fixVersions: string[]; affectsVersions: string[]; sprints: string[]; milestones: number; parent: string | null }
  keptByName: { components: string[]; fixVersions: string[]; affectsVersions: string[] }
  subtasks: Array<{ key: string; summary: string; status: string; becomes: string }>
  warnings: string[]
  blockers: string[]
  canApply: boolean
}
export interface MoveInput { projectId: number; issueTypeId?: number; statusId?: number }

export function useMovePreview() {
  return useMutation({
    mutationFn: ({ key, input }: { key: string; input: MoveInput }) =>
      api<MovePlan>(`/rest/api/2/issue/${enc(key)}/move?preview=true`, { method: 'POST', body: JSON.stringify(input) }),
  })
}
