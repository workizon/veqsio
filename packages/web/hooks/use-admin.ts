import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || `HTTP ${res.status}`)
  }
  return res.json()
}

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */

export interface User {
  self: string
  id?: string
  key: string
  name: string
  displayName?: string
  emailAddress: string
  avatarUrls: Record<string, string>
  active: boolean
  timeZone: string
}

export interface UserListResponse {
  startAt: number
  maxResults: number
  total: number
  isLast: boolean
  values: User[]
}

export function useUsers(startAt = 0, maxResults = 50, query = '', orderBy = '') {
  return useQuery({
    queryKey: ['users', startAt, maxResults, query, orderBy],
    queryFn: () => fetchJson<UserListResponse>(`/rest/api/2/user?startAt=${startAt}&maxResults=${maxResults}${query ? `&query=${encodeURIComponent(query)}` : ''}${orderBy ? `&orderBy=${encodeURIComponent(orderBy)}` : ''}`),
    placeholderData: (prev) => prev,
  })
}

export function useUserSearch(query: string) {
  return useQuery({
    queryKey: ['user-search', query],
    queryFn: () => fetchJson<User[]>(`/rest/api/2/user/search?query=${encodeURIComponent(query)}`),
    enabled: query.length > 0,
  })
}

export function useCreateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      username: string
      email: string
      displayName: string
      password: string
      active?: boolean
      avatarUrl?: string
      groups?: string[]
    }) =>
      fetchJson<User>('/rest/api/2/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })
}

export function useUpdateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      username: string
      displayName?: string
      email?: string
      active?: boolean
      avatarUrl?: string
      groups?: string[]
    }) =>
      fetchJson<User>('/rest/api/2/user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      queryClient.invalidateQueries({ queryKey: ['user-search'] })
    },
  })
}

export function useDeactivateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (username: string) =>
      fetchJson<void>(`/rest/api/2/user?username=${encodeURIComponent(username)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Groups                                                             */
/* ------------------------------------------------------------------ */

export interface Group {
  id: string
  name: string
  html: string
  description: string | null
  memberCount?: number
}

export interface GroupListResponse {
  startAt: number
  maxResults: number
  total: number
  isLast: boolean
  values: Group[]
}

export interface GroupMember {
  id: number
  username: string
  displayName: string
  email: string
}

/** Without params the list is the first 1000 groups (pickers); the admin screen pages and searches on the server. */
export function useGroups(params?: { startAt?: number; maxResults?: number; query?: string; orderBy?: string }) {
  const qs = new URLSearchParams()
  if (params?.startAt) qs.set('startAt', String(params.startAt))
  if (params?.maxResults) qs.set('maxResults', String(params.maxResults))
  if (params?.query) qs.set('query', params.query)
  if (params?.orderBy) qs.set('orderBy', params.orderBy)
  const suffix = qs.toString() ? `?${qs}` : ''
  return useQuery({
    queryKey: ['groups', params ?? null],
    queryFn: () => fetchJson<GroupListResponse>(`/rest/api/2/group${suffix}`),
    placeholderData: (prev) => prev,
  })
}

export function useCreateGroup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      fetchJson<Group>('/rest/api/2/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] })
    },
  })
}

export function useDeleteGroup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (groupname: string) =>
      fetchJson<void>(`/rest/api/2/group?groupname=${encodeURIComponent(groupname)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] })
    },
  })
}

export function useGroupMembers(groupname: string, params?: { startAt?: number; maxResults?: number; query?: string; orderBy?: string }) {
  const qs = new URLSearchParams({ groupname })
  if (params?.startAt) qs.set('startAt', String(params.startAt))
  if (params?.maxResults) qs.set('maxResults', String(params.maxResults))
  if (params?.query) qs.set('query', params.query)
  return useQuery({
    queryKey: ['group-members', groupname, params ?? null],
    queryFn: () => fetchJson<{ startAt: number; maxResults: number; total: number; isLast: boolean; values: GroupMember[] }>(`/rest/api/2/group/member?${qs}`),
    enabled: !!groupname,
    placeholderData: (prev) => prev,
  })
}

export function useAddGroupMember() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { groupname: string; username: string }) =>
      fetchJson<void>(`/rest/api/2/group/user?groupname=${encodeURIComponent(data.groupname)}&username=${encodeURIComponent(data.username)}`, {
        method: 'POST',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['group-members', variables.groupname] })
      queryClient.invalidateQueries({ queryKey: ['groups'] })
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })
}

export function useRemoveGroupMember() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { groupname: string; username: string }) =>
      fetchJson<void>(`/rest/api/2/group/user?groupname=${encodeURIComponent(data.groupname)}&username=${encodeURIComponent(data.username)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['group-members', variables.groupname] })
      queryClient.invalidateQueries({ queryKey: ['groups'] })
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Permission Schemes                                                 */
/* ------------------------------------------------------------------ */

export interface PermissionHolder {
  type: string
  id: number
  name: string
}

export interface PermissionEntry {
  id?: string
  permission: string
  holder: PermissionHolder | null
}

export interface PermissionScheme {
  id: string
  name: string
  description: string | null
  permissions: PermissionEntry[]
}

export function usePermissionSchemes() {
  return useQuery({
    queryKey: ['permission-schemes'],
    queryFn: () => fetchJson<{ permissionSchemes: PermissionScheme[] }>('/rest/api/2/permissionscheme'),
  })
}

export function useCreatePermissionScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      name: string
      description?: string
      permissions?: { permission: string; userId?: number; groupId?: number; projectRoleId?: number; anyUser?: boolean; projectLead?: boolean; anonymous?: boolean }[]
    }) =>
      fetchJson<PermissionScheme>('/rest/api/2/permissionscheme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permission-schemes'] })
    },
  })
}

export function useUpdatePermissionScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      id: string
      name?: string
      description?: string
      permissions?: { permission: string; userId?: number; groupId?: number; projectRoleId?: number; anyUser?: boolean; projectLead?: boolean; anonymous?: boolean }[]
    }) =>
      fetchJson<PermissionScheme>(`/rest/api/2/permissionscheme/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          description: data.description,
          permissions: data.permissions,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permission-schemes'] })
    },
  })
}

export function useDeletePermissionScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<void>(`/rest/api/2/permissionscheme/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permission-schemes'] })
    },
  })
}

export function useAssignPermissionScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { schemeId: string; projectId: number }) =>
      fetchJson<void>(`/rest/api/2/permissionscheme/${data.schemeId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: data.projectId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permission-schemes'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export function useCopyPermissionScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: string; name: string; description?: string }) =>
      fetchJson<PermissionScheme>(`/rest/api/2/permissionscheme/${data.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.name, description: data.description }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permission-schemes'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Permissions & Roles                                                */
/* ------------------------------------------------------------------ */

export interface Permission {
  id: number
  key: string
  name: string
  type: 'GLOBAL' | 'PROJECT'
}

export function usePermissions() {
  return useQuery({
    queryKey: ['permissions'],
    queryFn: () => fetchJson<{ permissions: Permission[] }>('/rest/api/2/permissions'),
  })
}

export interface IssueType {
  id: number
  name: string
  description: string | null
  iconUrl: string | null
  subtask: boolean
}

export function useIssueTypes() {
  return useQuery({
    queryKey: ['issue-types'],
    queryFn: () => fetchJson<IssueType[]>('/rest/api/2/issuetype'),
  })
}

export interface FieldListItem {
  id: string
  name: string
  custom: boolean
  schema: { type: string; system?: string; customId?: number }
}

export function useFieldList() {
  return useQuery({
    queryKey: ['fields'],
    queryFn: () => fetchJson<FieldListItem[]>('/rest/api/2/field'),
  })
}

export interface Workflow {
  id: string
  name: string
  description: string | null
}

export interface WorkflowListResponse {
  startAt: number
  maxResults: number
  total: number
  isLast: boolean
  values: Workflow[]
}

export function useWorkflows() {
  return useQuery({
    queryKey: ['workflows'],
    queryFn: () => fetchJson<WorkflowListResponse>('/rest/api/2/workflow'),
  })
}

export interface ProjectRole {
  id: number
  name: string
  description: string | null
}

export function useProjectRoles() {
  return useQuery({
    queryKey: ['project-roles'],
    queryFn: () => fetchJson<{ roles: ProjectRole[] }>('/rest/api/2/role'),
  })
}

/* ------------------------------------------------------------------ */
/*  Server Info                                                        */
/* ------------------------------------------------------------------ */

export interface ServerInfo {
  baseUrl: string
  version: string
  versionNumbers: number[]
  deploymentType: string
  buildNumber: number
  buildDate: string
  serverTime: string
  scmInfo: string
  serverTitle: string
  uptime: number
  startTime: string
  dbStatus: string
  stats: {
    issues: number
    projects: number
    users: number
  }
}

export function useServerInfo() {
  return useQuery({
    queryKey: ['server-info'],
    queryFn: () => fetchJson<ServerInfo>('/rest/api/2/serverInfo'),
    refetchInterval: 30000,
  })
}

/* ------------------------------------------------------------------ */
/*  Issue Type Schemes                                                 */
/* ------------------------------------------------------------------ */

export interface IssueTypeScheme {
  id: number
  name: string
  defaultIssueTypeId: number | null
  issueTypes: { id: number; name: string; iconUrl: string | null }[]
  projects: { id: number; name: string }[]
}

export function useIssueTypeSchemes() {
  return useQuery({
    queryKey: ['issue-type-schemes'],
    queryFn: () => fetchJson<{ schemes: IssueTypeScheme[] }>('/rest/api/2/admin/issuetypescheme'),
  })
}

export function useCreateIssueTypeScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      name: string
      defaultIssueTypeId?: number
      issueTypeIds: number[]
    }) =>
      fetchJson<{ id: number }>('/rest/api/2/admin/issuetypescheme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue-type-schemes'] })
    },
  })
}

export function useUpdateIssueTypeScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      id: number
      name?: string
      defaultIssueTypeId?: number
      issueTypeIds?: number[]
    }) =>
      fetchJson<void>(`/rest/api/2/admin/issuetypescheme/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue-type-schemes'] })
    },
  })
}

export function useDeleteIssueTypeScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      fetchJson<void>(`/rest/api/2/admin/issuetypescheme/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue-type-schemes'] })
    },
  })
}

export function useAssignIssueTypeScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { schemeId: number; projectId: number }) =>
      fetchJson<void>(`/rest/api/2/admin/issuetypescheme/${data.schemeId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: data.projectId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue-type-schemes'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Screens                                                            */
/* ------------------------------------------------------------------ */

export interface ScreenTab {
  id: number
  name: string
  sortOrder: number
  fields: { id: number; fieldId: number; isCustomField: boolean; fieldKey?: string | null; required?: boolean; sortOrder: number }[]
}

export interface Screen {
  id: number
  name: string
  description: string | null
  tabs: ScreenTab[]
}

export function useScreens() {
  return useQuery({
    queryKey: ['screens'],
    queryFn: () => fetchJson<{ screens: Screen[] }>('/rest/api/2/admin/screen'),
  })
}

export function useCreateScreen() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      fetchJson<{ id: number }>('/rest/api/2/admin/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['screens'] })
    },
  })
}

export function useUpdateScreen() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: number; name?: string; description?: string }) =>
      fetchJson<void>(`/rest/api/2/admin/screen/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['screens'] })
    },
  })
}

export function useDeleteScreen() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      fetchJson<void>(`/rest/api/2/admin/screen/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['screens'] })
    },
  })
}

export function useCreateScreenTab() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { screenId: number; name: string }) =>
      fetchJson<{ id: number }>(`/rest/api/2/admin/screen/${data.screenId}/tab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.name }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['screens'] })
    },
  })
}

export function useUpdateScreenTab() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { screenId: number; tabId: number; name?: string; sortOrder?: number }) =>
      fetchJson<void>(`/rest/api/2/admin/screen/${data.screenId}/tab/${data.tabId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.name, sortOrder: data.sortOrder }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['screens'] })
    },
  })
}

export function useDeleteScreenTab() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { screenId: number; tabId: number }) =>
      fetchJson<void>(`/rest/api/2/admin/screen/${data.screenId}/tab/${data.tabId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['screens'] })
    },
  })
}

export function useAddScreenTabField() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { screenId: number; tabId: number; fieldId?: number; fieldKey?: string; isCustomField?: boolean; required?: boolean }) =>
      fetchJson<void>(`/rest/api/2/admin/screen/${data.screenId}/tab/${data.tabId}/field`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldId: data.fieldId, fieldKey: data.fieldKey, isCustomField: data.isCustomField ?? false, required: data.required ?? false }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['screens'] })
    },
  })
}

/** Fields a screen can hold: the system fields a transition can collect and every custom field. */
export interface ScreenFieldCatalogItem { key: string; name: string; custom: boolean; fieldId: number; type: string }

export function useScreenFieldCatalog() {
  return useQuery({
    queryKey: ['screen-field-catalog'],
    queryFn: () => fetchJson<{ fields: ScreenFieldCatalogItem[] }>('/rest/api/2/admin/screen-fields'),
  })
}

export function useSetScreenFieldRequired() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { screenId: number; tabId: number; fieldId: number; required: boolean }) =>
      fetchJson<void>(`/rest/api/2/admin/screen/${data.screenId}/tab/${data.tabId}/field/${data.fieldId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: data.required }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['screens'] })
    },
  })
}

export function useRemoveScreenTabField() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { screenId: number; tabId: number; fieldId: number }) =>
      fetchJson<void>(`/rest/api/2/admin/screen/${data.screenId}/tab/${data.tabId}/field/${data.fieldId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['screens'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Field Configurations                                               */
/* ------------------------------------------------------------------ */

export interface FieldConfigItem {
  id: number
  fieldId: number
  isCustomField: boolean
  isVisible: boolean
  isRequired: boolean
  renderer: string | null
}

export interface FieldConfiguration {
  id: number
  name: string
  description: string | null
  items: FieldConfigItem[]
}

export function useFieldConfigurations() {
  return useQuery({
    queryKey: ['field-configurations'],
    queryFn: () => fetchJson<{ configurations: FieldConfiguration[] }>('/rest/api/2/admin/fieldconfiguration'),
  })
}

export function useCreateFieldConfiguration() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      fetchJson<{ id: number }>('/rest/api/2/admin/fieldconfiguration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-configurations'] })
    },
  })
}

export function useUpdateFieldConfiguration() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: number; name?: string; description?: string; items?: { id?: number; fieldId: number; isCustomField?: boolean; isVisible?: boolean; isRequired?: boolean; renderer?: string }[] }) =>
      fetchJson<void>(`/rest/api/2/admin/fieldconfiguration/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-configurations'] })
    },
  })
}

export function useDeleteFieldConfiguration() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      fetchJson<void>(`/rest/api/2/admin/fieldconfiguration/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-configurations'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Workflow Schemes                                                   */
/* ------------------------------------------------------------------ */

export interface WorkflowSchemeItem {
  issueTypeId: number
  issueTypeName: string
  workflowId: number
  workflowName: string
}

export interface WorkflowScheme {
  id: number
  name: string
  description: string | null
  items: WorkflowSchemeItem[]
  projects: { id: number; name: string }[]
}

export function useWorkflowSchemes() {
  return useQuery({
    queryKey: ['workflow-schemes'],
    queryFn: () => fetchJson<{ schemes: WorkflowScheme[] }>('/rest/api/2/admin/workflowscheme'),
  })
}

export function useCreateWorkflowScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; description?: string; items?: { issueTypeId: number; workflowId: number }[] }) =>
      fetchJson<{ id: number }>('/rest/api/2/admin/workflowscheme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow-schemes'] })
    },
  })
}

export function useUpdateWorkflowScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: number; name?: string; description?: string; items?: { issueTypeId: number; workflowId: number }[] }) =>
      fetchJson<void>(`/rest/api/2/admin/workflowscheme/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow-schemes'] })
    },
  })
}

export function useDeleteWorkflowScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      fetchJson<void>(`/rest/api/2/admin/workflowscheme/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow-schemes'] })
    },
  })
}

export function useAssignWorkflowScheme() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { schemeId: number; projectId: number }) =>
      fetchJson<void>(`/rest/api/2/admin/workflowscheme/${data.schemeId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: data.projectId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow-schemes'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Project Roles                                                      */
/* ------------------------------------------------------------------ */

export interface ProjectRoleActor {
  id: number
  projectId: number
  type: string
  user: { id: number; displayName: string | null } | null
  group: { id: number; name: string | null } | null
}

export interface AdminProjectRole {
  id: number
  name: string
  description: string | null
  actors: ProjectRoleActor[]
}

export function useAdminProjectRoles() {
  return useQuery({
    queryKey: ['admin-project-roles'],
    queryFn: () => fetchJson<{ roles: AdminProjectRole[] }>('/rest/api/2/admin/projectrole'),
  })
}

export function useCreateProjectRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      fetchJson<{ id: number }>('/rest/api/2/admin/projectrole', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-project-roles'] })
    },
  })
}

export function useUpdateProjectRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: number; name?: string; description?: string }) =>
      fetchJson<void>(`/rest/api/2/admin/projectrole/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-project-roles'] })
    },
  })
}

export function useDeleteProjectRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      fetchJson<void>(`/rest/api/2/admin/projectrole/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-project-roles'] })
    },
  })
}

export function useAddProjectRoleActor() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { roleId: number; projectId: number; userId?: number; groupId?: number }) =>
      fetchJson<void>(`/rest/api/2/admin/projectrole/${data.roleId}/actor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: data.projectId, userId: data.userId, groupId: data.groupId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-project-roles'] })
    },
  })
}

export function useRemoveProjectRoleActor() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { roleId: number; actorId: number }) =>
      fetchJson<void>(`/rest/api/2/admin/projectrole/${data.roleId}/actor/${data.actorId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-project-roles'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Custom Fields                                                      */
/* ------------------------------------------------------------------ */

export interface CustomFieldOption {
  id: number
  contextId: number
  value: string
  sortOrder: number
  description?: string | null
  color?: string | null
  archived?: boolean
}

export interface CustomFieldContext {
  id: number
  projectId: number | null
  issueTypeId: number | null
}

export interface AdminCustomField {
  id: number
  name: string
  fieldType: string
  description: string | null
  defaultValue: string | null
  isGlobal: boolean
  contexts: CustomFieldContext[]
  options: CustomFieldOption[]
}

export function useAdminCustomFields() {
  return useQuery({
    queryKey: ['admin-custom-fields'],
    queryFn: () => fetchJson<{ customFields: AdminCustomField[] }>('/rest/api/2/admin/customfield'),
  })
}

export function useCreateCustomField() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; fieldType: string; description?: string; defaultValue?: string; isGlobal?: boolean }) =>
      fetchJson<{ id: number }>('/rest/api/2/admin/customfield', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-custom-fields'] })
    },
  })
}

export function useUpdateCustomField() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: number; name?: string; description?: string; defaultValue?: string; isGlobal?: boolean }) =>
      fetchJson<void>(`/rest/api/2/admin/customfield/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-custom-fields'] })
    },
  })
}

export function useDeleteCustomField() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      fetchJson<void>(`/rest/api/2/admin/customfield/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-custom-fields'] })
    },
  })
}

export function useAddCustomFieldContext() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { fieldId: number; projectId?: number; issueTypeId?: number }) =>
      fetchJson<void>(`/rest/api/2/admin/customfield/${data.fieldId}/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: data.projectId, issueTypeId: data.issueTypeId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-custom-fields'] })
    },
  })
}

export function useRemoveCustomFieldContext() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { fieldId: number; contextId: number }) =>
      fetchJson<void>(`/rest/api/2/admin/customfield/${data.fieldId}/context/${data.contextId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-custom-fields'] })
    },
  })
}

export function useAddCustomFieldOption() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { fieldId: number; contextId: number; value: string }) =>
      fetchJson<void>(`/rest/api/2/admin/customfield/${data.fieldId}/option`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextId: data.contextId, value: data.value }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-custom-fields'] })
    },
  })
}

export function useUpdateCustomFieldOption() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { fieldId: number; optionId: number; patch: { value?: string; description?: string | null; color?: string | null; archived?: boolean } }) =>
      fetchJson<void>(`/rest/api/2/admin/customfield/${data.fieldId}/option/${data.optionId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data.patch),
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin-custom-fields'] }) },
  })
}

export function useRemoveCustomFieldOption() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { fieldId: number; optionId: number }) =>
      fetchJson<void>(`/rest/api/2/admin/customfield/${data.fieldId}/option/${data.optionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-custom-fields'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Audit Log                                                          */
/* ------------------------------------------------------------------ */

export interface AuditLogEntry {
  id: number
  timestamp: string
  user: string
  action: string
  entity: string
  details: string
}

export function useAuditLog(params?: { user?: string; action?: string; from?: string; to?: string }) {
  const query = new URLSearchParams()
  if (params?.user) query.set('user', params.user)
  if (params?.action) query.set('action', params.action)
  if (params?.from) query.set('from', params.from)
  if (params?.to) query.set('to', params.to)

  return useQuery({
    queryKey: ['audit-log', params],
    queryFn: () => fetchJson<{ logs: AuditLogEntry[] }>(`/rest/api/2/admin/auditlog?${query.toString()}`),
  })
}

/* ------------------------------------------------------------------ */
/*  System Configuration                                                */
/* ------------------------------------------------------------------ */

export interface SystemConfig {
  siteName: string
  baseUrl: string
  defaultLanguage: string
  dateFormat: string
  timezone: string
}

export function useSystemConfig() {
  return useQuery({
    queryKey: ['system-config'],
    queryFn: () => fetchJson<SystemConfig>('/rest/api/2/admin/system/config'),
  })
}

export function useUpdateSystemConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Partial<SystemConfig>) =>
      fetchJson<{ success: boolean }>('/rest/api/2/admin/system/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-config'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  License                                                            */
/* ------------------------------------------------------------------ */

export interface LicenseInfo {
  plan: string
  status: string
  seats: number
  usedSeats: number
  expiryDate: string
  supportLevel: string
  features: string[]
}

export function useLicense() {
  return useQuery({
    queryKey: ['license'],
    queryFn: () => fetchJson<LicenseInfo>('/rest/api/2/admin/system/license'),
  })
}

/* ------------------------------------------------------------------ */
/*  Mail Server                                                        */
/* ------------------------------------------------------------------ */

export interface MailConfig {
  host: string
  port: number
  user: string
  pass: string
  from: string
  tls: boolean
}

export function useMailConfig() {
  return useQuery({
    queryKey: ['mail-config'],
    queryFn: () => fetchJson<MailConfig>('/rest/api/2/admin/system/mail'),
  })
}

export function useUpdateMailConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: MailConfig) =>
      fetchJson<{ success: boolean }>('/rest/api/2/admin/system/mail', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mail-config'] })
    },
  })
}

export function useTestMailConfig() {
  return useMutation({
    mutationFn: (data: { to: string }) =>
      fetchJson<{ success: boolean; message: string }>('/rest/api/2/admin/system/mail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
  })
}

/* ------------------------------------------------------------------ */
/*  Backup & Restore                                                   */
/* ------------------------------------------------------------------ */

export interface Backup {
  id: string
  name: string
  size: string
  createdAt: string
  type: string
}

