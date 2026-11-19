import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SecurityScheme, MemberType, UsedLevel } from '@/lib/issue-security'

export class ApiError extends Error {
  status: number
  used?: UsedLevel[]
  constructor(message: string, status: number, used?: UsedLevel[]) {
    super(message)
    this.status = status
    this.used = used
  }
}

async function call<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.errorMessages?.[0] || `HTTP ${res.status}`, res.status, data.usedLevels)
  return data as T
}

const BASE = '/rest/api/2/admin/issuesecurity'
const KEY = ['issue-security', 'schemes']

export function useSecuritySchemes() {
  return useQuery<{ schemes: SecurityScheme[] }>({ queryKey: KEY, queryFn: () => call(BASE) })
}

/** Run a mutation and refresh the scheme list plus everything that depends on visibility. */
function useAdminMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['project-security'] })
      qc.invalidateQueries({ queryKey: ['issue'] })
    },
  })
}

export const useCreateScheme = () => useAdminMutation((b: { name: string; description?: string | null }) => call(BASE, { method: 'POST', body: JSON.stringify(b) }))
export const useUpdateScheme = () => useAdminMutation(({ id, ...b }: { id: number; name?: string; description?: string | null; defaultLevelId?: number | null }) => call(`${BASE}/${id}`, { method: 'PUT', body: JSON.stringify(b) }))
export const useDeleteScheme = () => useAdminMutation((id: number) => call(`${BASE}/${id}`, { method: 'DELETE' }))
export const useCreateLevel = () => useAdminMutation(({ schemeId, ...b }: { schemeId: number; name: string; description?: string | null }) => call(`${BASE}/${schemeId}/level`, { method: 'POST', body: JSON.stringify(b) }))
export const useUpdateLevel = () => useAdminMutation(({ schemeId, levelId, ...b }: { schemeId: number; levelId: number; name?: string; description?: string | null }) => call(`${BASE}/${schemeId}/level/${levelId}`, { method: 'PUT', body: JSON.stringify(b) }))
export const useDeleteLevel = () => useAdminMutation(({ schemeId, levelId }: { schemeId: number; levelId: number }) => call(`${BASE}/${schemeId}/level/${levelId}`, { method: 'DELETE' }))
export const useAddMember = () => useAdminMutation(({ schemeId, levelId, ...b }: { schemeId: number; levelId: number; type: MemberType; userId?: number; groupId?: number; roleId?: number }) => call(`${BASE}/${schemeId}/level/${levelId}/member`, { method: 'POST', body: JSON.stringify(b) }))
export const useRemoveMember = () => useAdminMutation(({ schemeId, levelId, memberId }: { schemeId: number; levelId: number; memberId: number }) => call(`${BASE}/${schemeId}/level/${levelId}/member/${memberId}`, { method: 'DELETE' }))
export const useAssignProjectScheme = () => useAdminMutation(({ projectId, schemeId, levelMapping }: { projectId: number; schemeId: number | null; levelMapping?: Record<string, number | null> }) =>
  call(`${BASE}/project/${projectId}`, { method: 'PUT', body: JSON.stringify({ schemeId, levelMapping }) }))

export interface ProjectSecurity {
  scheme: { id: number; name: string } | null
  defaultLevelId: number | null
  levels: Array<{ id: number; name: string; description: string | null }>
  canSet: boolean
}

/** Levels a project offers and whether the caller may set them (SET_ISSUE_SECURITY). */
export function useProjectSecurity(projectKey: string | undefined) {
  return useQuery<ProjectSecurity>({
    queryKey: ['project-security', projectKey],
    queryFn: () => call(`/rest/api/2/project/${encodeURIComponent(projectKey!)}/issuesecurity`),
    enabled: !!projectKey,
    staleTime: 30_000,
  })
}
