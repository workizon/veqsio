import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Progress } from '@/hooks/use-initiatives'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
    throw new Error(msg)
  }
  return res.json()
}

export interface MilestoneIssue { key: string; summary: string; type: string; status: string; statusCategory: string }
export interface Milestone {
  id: number; name: string; description: string; targetDate: string | null; state: 'open' | 'reached'; reachedAt: string | null
  overdue: boolean; progress: Progress; issues?: MilestoneIssue[]
}
export interface IssueMilestone { id: number; name: string; state: string; targetDate: string | null }

const base = (project: string) => `/rest/api/2/project/${encodeURIComponent(project)}/milestones`

export function useMilestones(project: string, enabled = true) {
  return useQuery({ queryKey: ['milestones', project], enabled: enabled && !!project, queryFn: () => api<{ milestones: Milestone[]; canManage: boolean }>(base(project)) })
}

export function useMilestone(project: string, id: number | null) {
  return useQuery({ queryKey: ['milestones', project, id], enabled: !!id, queryFn: () => api<Milestone>(`${base(project)}/${id}`) })
}

function useInvalidating<T>(fn: (v: T) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => { qc.invalidateQueries({ queryKey: ['milestones'] }); qc.invalidateQueries({ queryKey: ['issue-milestones'] }); qc.invalidateQueries({ queryKey: ['roadmap'] }) } })
}

export const useCreateMilestone = (project: string) => useInvalidating((v: { name: string; description?: string; targetDate?: string | null }) => api<Milestone>(base(project), { method: 'POST', body: JSON.stringify(v) }))
export const useUpdateMilestone = (project: string) => useInvalidating((v: { id: number; patch: Partial<{ name: string; description: string; targetDate: string | null; state: 'open' | 'reached' }> }) => api<Milestone>(`${base(project)}/${v.id}`, { method: 'PUT', body: JSON.stringify(v.patch) }))
export const useDeleteMilestone = (project: string) => useInvalidating((id: number) => api<unknown>(`${base(project)}/${id}`, { method: 'DELETE' }))
export const useLinkMilestoneIssue = (project: string) => useInvalidating((v: { id: number; issueKey: string }) => api<Milestone>(`${base(project)}/${v.id}/issues`, { method: 'POST', body: JSON.stringify({ issueKey: v.issueKey }) }))
export const useUnlinkMilestoneIssue = (project: string) => useInvalidating((v: { id: number; issueKey: string }) => api<unknown>(`${base(project)}/${v.id}/issues/${encodeURIComponent(v.issueKey)}`, { method: 'DELETE' }))

export function useIssueMilestones(issueKey: string, enabled = true) {
  return useQuery({ queryKey: ['issue-milestones', issueKey], enabled: enabled && !!issueKey, retry: false, queryFn: () => api<{ milestones: IssueMilestone[] }>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/milestones`).then((r) => r.milestones) })
}
export const useSetIssueMilestones = (issueKey: string) => useInvalidating((milestoneIds: number[]) => api<unknown>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/milestones`, { method: 'PUT', body: JSON.stringify({ milestoneIds }) }))

/* ---- releases ---- */

export interface ReleaseVersion {
  id: number; name: string; description: string | null; startDate: string | null; releaseDate: string | null
  released: boolean; archived: boolean; overdue: boolean; progress: Progress; openIssueCount: number
  issues: MilestoneIssue[]
}
export function useReleases(project: string, archived: boolean) {
  return useQuery({
    queryKey: ['releases', project, archived], enabled: !!project,
    queryFn: () => api<{ project: { key: string; name: string }; canRelease: boolean; versions: ReleaseVersion[] }>(`/rest/api/2/project/${encodeURIComponent(project)}/releases${archived ? '?archived=true' : ''}`),
  })
}
export function useReleaseNotes(project: string, versionId: number | null) {
  return useQuery({
    queryKey: ['release-notes', project, versionId], enabled: !!versionId,
    queryFn: () => api<{ version: string; releaseDate: string | null; groups: Array<{ type: string; issues: Array<{ key: string; summary: string }> }> }>(`/rest/api/2/project/${encodeURIComponent(project)}/versions/${versionId}/release-notes?format=json`),
  })
}
export function useMarkReleased(project: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: number; releaseDate: string | null }) => api<unknown>(`/rest/api/2/project/${encodeURIComponent(project)}/versions/${v.id}`, {
      method: 'PUT', body: JSON.stringify({ released: true, releaseDate: v.releaseDate ?? new Date().toISOString().slice(0, 10) }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['releases'] }); qc.invalidateQueries({ queryKey: ['roadmap'] }) },
  })
}
