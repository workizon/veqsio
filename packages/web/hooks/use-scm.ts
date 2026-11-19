import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
    throw Object.assign(new Error(msg), { status: res.status })
  }
  return res.json()
}

export type ScmProvider = 'github' | 'gitlab' | 'gitea' | 'bitbucket'
export interface ScmRepo { id: number; provider: ScmProvider; baseUrl: string | null; name: string; defaultBranch: string; hasToken: boolean }
export interface ScmRepoCreated extends ScmRepo { webhookUrl: string; webhookSecret: string }
export interface DevLink { id: number; repository: string; provider: ScmProvider; ref: string; branch: string | null; title: string | null; url: string | null; status: string | null; buildStatus: string | null; author: string | null; updated: string }
export interface Development {
  branches: DevLink[]; commits: DevLink[]; pullRequests: DevLink[]
  repositories: Array<{ id: number; provider: ScmProvider; name: string; canCreateBranch: boolean }>
  suggestedBranch: string; canCreateBranch: boolean
}

const reposKey = (project: string) => ['scm-repos', project]

export function useScmRepos(project: string) {
  return useQuery({ queryKey: reposKey(project), queryFn: () => api<ScmRepo[]>(`/rest/api/2/project/${encodeURIComponent(project)}/repositories`) })
}

export function useLinkRepo(project: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { provider: ScmProvider; name: string; baseUrl?: string | null; defaultBranch?: string; accessToken?: string | null }) =>
      api<ScmRepoCreated>(`/rest/api/2/project/${encodeURIComponent(project)}/repositories`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: reposKey(project) }),
  })
}

export function useRotateSecret(project: string) {
  return useMutation({
    mutationFn: (id: number) => api<ScmRepoCreated>(`/rest/api/2/project/${encodeURIComponent(project)}/repositories/${id}/rotate-secret`, { method: 'POST' }),
  })
}

export function useUnlinkRepo(project: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api<unknown>(`/rest/api/2/project/${encodeURIComponent(project)}/repositories/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: reposKey(project) }),
  })
}

export function useDevelopment(issueKey: string) {
  return useQuery({ queryKey: ['issue', issueKey, 'development'], queryFn: () => api<Development>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/development`), retry: false })
}

export function useCreateBranch(issueKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { repositoryId: number; name?: string; from?: string }) =>
      api<{ branch: string; url: string }>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/development/branch`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['issue', issueKey, 'development'] }),
  })
}
