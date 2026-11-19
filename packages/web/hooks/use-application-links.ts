import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface ApplicationLink {
  id: number
  name: string
  type: string
  baseUrl: string
  displayUrl?: string
  authType: string
  credentials?: Record<string, any>
  config: Record<string, any>
  isPrimary: boolean
  active: boolean
  createdAt: string
}

export interface DevData {
  commits: DevCommit[]
  branches: DevBranch[]
  pullRequests: DevPullRequest[]
}

export interface DevCommit {
  id: number
  commitId: string
  message: string
  authorName?: string
  url?: string
  branch?: string
  committedAt: string
}

export interface DevBranch {
  id: number
  name: string
  isDefault?: boolean
  aheadBy?: number
  behindBy?: number
  lastCommitAt?: string
  url?: string
}

export interface DevPullRequest {
  id: number
  prId: string
  title: string
  authorName?: string
  status: string
  sourceBranch?: string
  targetBranch?: string
  url?: string
  createdAt: string
  updatedAt: string
}

export function useApplicationLinks() {
  return useQuery({
    queryKey: ['application-links'],
    queryFn: () => fetchJson<{ values: ApplicationLink[] }>('/rest/api/2/applicationlink'),
  })
}

export function useCreateApplicationLink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: Omit<ApplicationLink, 'id' | 'createdAt'>) =>
      fetchJson<ApplicationLink>('/rest/api/2/applicationlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['application-links'] }),
  })
}

export function useUpdateApplicationLink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<ApplicationLink> & { id: number }) =>
      fetchJson<ApplicationLink>(`/rest/api/2/applicationlink/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['application-links'] }),
  })
}

export function useDeleteApplicationLink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      fetchJson<{ success: boolean }>(`/rest/api/2/applicationlink/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['application-links'] }),
  })
}

export function useDevData(issueKey: string) {
  return useQuery({
    queryKey: ['dev-data', issueKey],
    queryFn: () => fetchJson<DevData>(`/rest/api/2/issue/${issueKey}/dev`),
    enabled: !!issueKey,
  })
}

export function useSyncDevData() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (linkId: number) =>
      fetchJson<{ success: boolean }>(`/rest/api/2/dev/sync/${linkId}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dev-data'] }),
  })
}
