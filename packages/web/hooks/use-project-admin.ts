import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export interface ProjectDetail {
  id: number
  key: string
  name: string
  description: string | null
  lead: { id: number; displayName: string } | null
  avatarUrl: string | null
  projectCategory: string | null
  archived?: boolean
}

export interface Component {
  id: number
  name: string
  description: string | null
  lead: { id: number; displayName: string } | null
}

export interface Version {
  id: number
  name: string
  description: string | null
  startDate: string | null
  releaseDate: string | null
  released: boolean | null
  archived: boolean | null
}

export interface ProjectRole {
  id: number
  name: string
  description: string | null
  actors: {
    id: number
    type: string
    user: { id: number; displayName: string; username?: string } | null
    group: { id: number; name: string } | null
  }[]
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ errorMessages: [`HTTP ${res.status}`] }))
    throw new Error(err.errorMessages?.[0] || `HTTP ${res.status}`)
  }
  return res.json()
}

export function useProject(key: string) {
  return useQuery<ProjectDetail>({
    queryKey: ['project', key],
    // the REST shape carries the picture as avatarUrls['48x48'] (Jira style); the settings screens read avatarUrl
    queryFn: async () => {
      const p = await fetchJson<ProjectDetail & { avatarUrls?: Record<string, string> }>(`/rest/api/2/project/${key}`)
      return { ...p, avatarUrl: p.avatarUrl ?? p.avatarUrls?.['48x48'] ?? null }
    },
    enabled: !!key,
  })
}

export function useUpdateProject(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: Partial<Pick<ProjectDetail, 'name' | 'description' | 'projectCategory' | 'avatarUrl'> & { leadId?: number }>) => {
      return fetchJson<ProjectDetail>(`/rest/api/2/project/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', key] })
    },
  })
}

export function useUploadProjectAvatar(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return fetchJson<{ id: number; avatarUrl: string }>(`/rest/api/2/project/${key}/avatar`, {
        method: 'POST',
        body: formData,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', key] })
    },
  })
}

export function useComponents(key: string) {
  return useQuery<Component[]>({
    queryKey: ['project-components', key],
    queryFn: () => fetchJson(`/rest/api/2/project/${key}/components`),
    enabled: !!key,
  })
}

export function useCreateComponent(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: { name: string; description?: string; leadId?: number }) => {
      return fetchJson<Component>(`/rest/api/2/project/${key}/components`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-components', key] })
    },
  })
}

export function useUpdateComponent(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: { name?: string; description?: string; leadId?: number } }) => {
      return fetchJson<Component>(`/rest/api/2/project/${key}/components/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-components', key] })
    },
  })
}

export function useDeleteComponent(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      return fetchJson(`/rest/api/2/project/${key}/components/${id}`, { method: 'DELETE' })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-components', key] })
    },
  })
}

export function useVersions(key: string) {
  return useQuery<Version[]>({
    queryKey: ['project-versions', key],
    queryFn: () => fetchJson(`/rest/api/2/project/${key}/versions`),
    enabled: !!key,
  })
}

export function useCreateVersion(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: {
      name: string
      description?: string
      startDate?: string
      releaseDate?: string
      archived?: boolean
    }) => {
      return fetchJson<Version>(`/rest/api/2/project/${key}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-versions', key] })
    },
  })
}

export function useUpdateVersion(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: number
      data: {
        name?: string
        description?: string
        startDate?: string | null
        releaseDate?: string | null
        archived?: boolean
        released?: boolean
      }
    }) => {
      return fetchJson<Version>(`/rest/api/2/project/${key}/versions/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-versions', key] })
    },
  })
}

export function useDeleteVersion(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      return fetchJson(`/rest/api/2/project/${key}/versions/${id}`, { method: 'DELETE' })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-versions', key] })
    },
  })
}

export function useProjectRoles(key: string) {
  return useQuery<ProjectRole[]>({
    queryKey: ['project-roles', key],
    queryFn: () => fetchJson(`/rest/api/2/project/${key}/role`),
    enabled: !!key,
  })
}

export function useAddProjectRoleActor(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: { roleId: number; userId?: number; groupId?: number; username?: string; groupName?: string }) => {
      const body: any = {}
      if (data.userId) body.user = { id: data.userId }
      if (data.groupId) body.group = { id: data.groupId }
      if (data.username) body.user = { name: data.username }
      if (data.groupName) body.group = { name: data.groupName }
      return fetchJson(`/rest/api/2/project/${key}/role/${data.roleId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-roles', key] })
    },
  })
}

export function useRemoveProjectRoleActor(key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: { roleId: number; user?: string; group?: string }) => {
      const params = new URLSearchParams()
      if (data.user) params.set('user', data.user)
      if (data.group) params.set('group', data.group)
      return fetchJson(`/rest/api/2/project/${key}/role/${data.roleId}?${params.toString()}`, {
        method: 'DELETE',
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-roles', key] })
    },
  })
}

export interface ProjectSummary {
  id: number
  key: string
  name: string
  avatarUrls?: Record<string, string>
  archived?: boolean
}

/** Archived projects are left out of lists and pickers by default; pass 'only' for the archived ones. */
export function useProjects(archived?: 'only' | 'include') {
  return useQuery<ProjectSummary[]>({
    queryKey: archived ? ['projects', archived] : ['projects'],
    // The endpoint returns a plain array (Jira-compatible); tolerate a paged `{ values }` shape too.
    queryFn: () =>
      fetchJson<ProjectSummary[] | { values?: ProjectSummary[] }>(`/rest/api/2/project${archived ? `?archived=${archived}` : ''}`)
        .then((d) => (Array.isArray(d) ? d : d.values ?? [])),
  })
}
