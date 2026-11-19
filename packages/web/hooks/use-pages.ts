import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PageSummary } from '@/lib/pages'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let data: any = {}
    try { data = await res.json() } catch {}
    throw Object.assign(new Error(data.errorMessages?.join(', ') || res.statusText), { status: res.status, currentVersion: data.currentVersion as number | undefined })
  }
  return res.json()
}

export interface PageDetail extends PageSummary {
  body: string
  projectName: string | null
  ancestors: Array<{ id: number; title: string }>
  linkedIssues: Array<{ id: number; issueKey: string; summary: string; status: string | null; quote: string | null; createdAt: string }>
  permissions: { canEdit: boolean; canLock: boolean; canComment: boolean; canModerate: boolean }
}
export interface PageVersionRow {
  version: number; title: string; author: { id: number; displayName: string | null } | null
  added: number; removed: number; restoredFrom: number | null; createdAt: string; size: number
}
export type HunkItem = { type: 'eq' | 'add' | 'del'; text: string } | { type: 'skip'; count: number }
export interface PageVersionDetail {
  version: number; title: string; body: string; createdAt: string; restoredFrom: number | null; isCurrent: boolean
  compared: string; titleChanged: { from: string; to: string } | null; summary: { added: number; removed: number }; diff: HunkItem[]
}
export interface PageComment {
  id: number; parentId: number | null; body: string; quote: string | null; createdAt: string; updatedAt: string
  author: { id: number; displayName: string | null } | null; canEdit: boolean; canDelete: boolean
}
export interface PageSearchHit { id: number; title: string; projectKey: string | null; updatedAt: string; snippet: string }

/** `scope`: a project key, or null for the workspace pages. */
export const pagesKey = (scope: string | null, archived = false) => ['pages', scope ?? '__workspace', archived]
const q = encodeURIComponent

export function usePages(scope: string | null, archived = false) {
  const url = scope ? `/rest/api/2/pages?project=${q(scope)}` : '/rest/api/2/pages?workspace=true'
  return useQuery({ queryKey: pagesKey(scope, archived), queryFn: () => api<{ pages: PageSummary[] }>(`${url}${archived ? '&archived=true' : ''}`).then((r) => r.pages) })
}

export function usePage(id: number | null) {
  return useQuery({ queryKey: ['page', id], enabled: id !== null, queryFn: () => api<PageDetail>(`/rest/api/2/pages/${id}`), retry: false })
}

export function usePageSearch(text: string, project?: string | null) {
  const term = text.trim()
  return useQuery({
    queryKey: ['page-search', term, project ?? null],
    enabled: term.length >= 2,
    queryFn: () => api<{ results: PageSearchHit[] }>(`/rest/api/2/pages/search?q=${q(term)}${project ? `&project=${q(project)}` : ''}`).then((r) => r.results),
    staleTime: 15_000,
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return (id?: number) => {
    qc.invalidateQueries({ queryKey: ['pages'] })
    qc.invalidateQueries({ queryKey: ['page-search'] })
    if (id !== undefined) {
      qc.invalidateQueries({ queryKey: ['page', id] })
      qc.invalidateQueries({ queryKey: ['page-versions', id] })
    }
  }
}

export function useCreatePage() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: { title: string; body?: string; parentId?: number | null; projectKey?: string | null }) =>
      api<{ id: number }>('/rest/api/2/pages', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(),
  })
}

export function useUpdatePage(id: number) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: { title?: string; body?: string; locked?: boolean; expectedVersion?: number }) =>
      api<{ id: number; version: number; changed: boolean }>(`/rest/api/2/pages/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(id),
  })
}

export function useMovePage(id: number) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: { parentId: number | null; index?: number }) => api<unknown>(`/rest/api/2/pages/${id}/move`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(id),
  })
}

export function useArchivePage(id: number) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (archive: boolean) => api<unknown>(`/rest/api/2/pages/${id}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' }),
    onSuccess: () => invalidate(id),
  })
}

export function usePageVersions(id: number, enabled = true) {
  return useQuery({ queryKey: ['page-versions', id], enabled, queryFn: () => api<{ current: number; versions: PageVersionRow[] }>(`/rest/api/2/pages/${id}/versions`) })
}

export function usePageVersion(id: number, version: number | null, compare: 'previous' | 'current') {
  return useQuery({
    queryKey: ['page-version', id, version, compare],
    enabled: version !== null,
    queryFn: () => api<PageVersionDetail>(`/rest/api/2/pages/${id}/versions/${version}${compare === 'current' ? '?compare=current' : ''}`),
  })
}

export function useRestoreVersion(id: number) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (version: number) => api<{ version: number; changed: boolean }>(`/rest/api/2/pages/${id}/versions/${version}/restore`, { method: 'POST' }),
    onSuccess: () => invalidate(id),
  })
}

export function usePageComments(id: number) {
  return useQuery({ queryKey: ['page-comments', id], queryFn: () => api<{ comments: PageComment[] }>(`/rest/api/2/pages/${id}/comments`).then((r) => r.comments) })
}

export function usePageCommentActions(id: number) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ['page-comments', id] })
  return {
    add: useMutation({
      mutationFn: (b: { body: string; parentId?: number | null; quote?: string | null }) => api<unknown>(`/rest/api/2/pages/${id}/comments`, { method: 'POST', body: JSON.stringify(b) }),
      onSuccess: done,
    }),
    edit: useMutation({
      mutationFn: (b: { commentId: number; body: string }) => api<unknown>(`/rest/api/2/pages/${id}/comments/${b.commentId}`, { method: 'PUT', body: JSON.stringify({ body: b.body }) }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (commentId: number) => api<unknown>(`/rest/api/2/pages/${id}/comments/${commentId}`, { method: 'DELETE' }),
      onSuccess: done,
    }),
  }
}

export function useConvertToIssue(id: number) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (b: { projectKey: string; text: string; summary?: string; issueTypeId?: number }) =>
      api<{ issue: { id: number; key: string } }>(`/rest/api/2/pages/${id}/convert-to-issue`, { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => invalidate(id),
  })
}
