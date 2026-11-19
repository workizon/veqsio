import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export interface LabelInfo {
  id: number
  name: string
  color: string | null
  removeOnResolve: boolean
  issueCount: number
}

/** Colour data attached to an issue (`fields.labelDetails`); `fields.labels` stays the plain string array. */
export interface LabelDetail {
  name: string
  color: string | null
  removeOnResolve: boolean
}

interface LabelListResponse {
  values: string[]
  labels: LabelInfo[]
  palette: string[]
}

async function labelFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err = new Error(data.errorMessages?.[0] || `HTTP ${res.status}`) as Error & { status?: number; conflictId?: number }
    err.status = res.status
    err.conflictId = data.conflictId
    throw err
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export function useLabels(enabled = true) {
  return useQuery<LabelListResponse, Error>({
    queryKey: ['labels'],
    queryFn: () => labelFetch<LabelListResponse>('/rest/api/2/label'),
    enabled,
    staleTime: 30_000,
  })
}

/** Name to colour lookup built from the label list, for chips that only have names (list, board). */
export function labelColorMap(labels: LabelInfo[] | undefined): Map<string, LabelDetail> {
  return new Map((labels ?? []).map((l) => [l.name, { name: l.name, color: l.color, removeOnResolve: l.removeOnResolve }]))
}

function useInvalidateLabels() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['labels'] })
    qc.invalidateQueries({ queryKey: ['issue'] })
    qc.invalidateQueries({ queryKey: ['issues', 'search'] })
  }
}

export function useCreateLabel() {
  const invalidate = useInvalidateLabels()
  return useMutation({
    mutationFn: (body: { name: string; color?: string | null; removeOnResolve?: boolean }) =>
      labelFetch<LabelInfo>('/rest/api/2/label', json('POST', body)),
    onSuccess: invalidate,
  })
}

export function useUpdateLabel() {
  const invalidate = useInvalidateLabels()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; name?: string; color?: string | null; removeOnResolve?: boolean }) =>
      labelFetch<LabelInfo>(`/rest/api/2/label/${id}`, json('PUT', body)),
    onSuccess: invalidate,
  })
}

export function useMergeLabel() {
  const invalidate = useInvalidateLabels()
  return useMutation({
    mutationFn: ({ id, targetId }: { id: number; targetId: number }) =>
      labelFetch<{ merged: LabelInfo; moved: number; duplicates: number }>(`/rest/api/2/label/${id}/merge`, json('POST', { targetId })),
    onSuccess: invalidate,
  })
}

export function useDeleteLabel() {
  const invalidate = useInvalidateLabels()
  return useMutation({
    mutationFn: (id: number) => labelFetch<void>(`/rest/api/2/label/${id}`, json('DELETE')),
    onSuccess: invalidate,
  })
}

export function useDeleteUnusedLabels() {
  const invalidate = useInvalidateLabels()
  return useMutation({
    mutationFn: () => labelFetch<{ deleted: number }>('/rest/api/2/label?unused=true', json('DELETE')),
    onSuccess: invalidate,
  })
}
