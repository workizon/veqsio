import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { patchIssueFields } from '@/lib/issue-view'
import { usePendingDeletes } from '@/hooks/pending-deletes'
import type { ScreenField } from '@/lib/transition-screen'

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  // The API marks GET answers `max-age=60`: without revalidation a refetch right after an edit, a drag or an undo would
  // show the old data for a minute and the optimistic change would snap back.
  const res = await fetch(url, { cache: 'no-cache', ...options, credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err = new Error(data.errorMessages?.[0] || `HTTP ${res.status}`) as Error & { validationErrors?: string[]; fieldErrors?: Record<string, string>; conflict?: { field: string; current: string | null }; status?: number }
    err.status = res.status
    if (data.conflict) err.conflict = data.conflict
    if (Array.isArray(data.validationErrors)) err.validationErrors = data.validationErrors
    if (data.errors && typeof data.errors === 'object') err.fieldErrors = data.errors
    throw err
  }
  return res.json()
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ApiIssueType {
  id: number
  name: string
  iconUrl?: string
  subtask: boolean
}

export interface ApiStatus {
  id: number
  name: string
  category: string
  color?: string
}

export interface ApiPriority {
  id: number
  name: string
  color?: string
}

export interface ApiUser {
  id: number
  displayName: string
  avatarUrl?: string
  /** AI agent service account */
  isAgent?: boolean
}

export interface ApiSubtask {
  id: number
  key: string
  summary: string
  status: { id: number; name?: string }
}

export interface ApiIssueLink {
  id: number
  type: { id: number; name: string; inward?: string; outward?: string; scheduling?: 'starts_before' | 'finishes_before' }
  inwardIssue?: { id: number; key: string; summary: string }
  outwardIssue?: { id: number; key: string; summary: string }
  /** Only on dependency links: whether the dates of the two issues contradict the dependency. */
  dependency?: { role: 'predecessor' | 'successor'; conflict: boolean; message: string | null }
}

export interface ApiAttachment {
  id: string
  filename: string
  size: number
  mimeType: string
  content: string
  thumbnail?: string | null
  author: { id: number; displayName?: string }
  created: string
}

export interface ApiTransition {
  id: number
  name: string
  to: { id: number; name: string; statusCategory: { key: string; normalizedKey?: string; name?: string } }
  hasScreen: boolean
  fields: Record<string, any>
  /** Additive fields: what the transition dialog has to ask for. */
  requiresResolution?: boolean
  requiresComment?: boolean
  requiresInput?: boolean
  requiredFields?: string[]
  /** Ordered fields of the transition screen, with required flags (additive). */
  screenFields?: ScreenField[]
}

export interface ApiResolution {
  id: string
  name: string
  description?: string | null
}

export interface ApiLinkType {
  id: string
  name: string
  inward: string
  outward: string
}

export interface ApiIssueTypeMeta {
  id: string
  name: string
  subtask: boolean
}

export interface ApiProjectSummary {
  id: number
  key: string
  name: string
}

export interface ApiWatcherData {
  watchCount: number
  isWatching: boolean
  watchers: { id: number; displayName: string }[]
}

export interface ApiVoteData {
  votes: number
  hasVoted: boolean
  voters: { id: number; displayName: string }[]
}

export interface ApiUserSearchResult {
  self: string
  key: string
  name: string
  displayName?: string
  username?: string
  emailAddress: string
  avatarUrls: Record<string, string>
  active: boolean
  timeZone: string
  id: number
  isAgent?: boolean
}

export interface ApiPriorityMeta {
  id: string
  name: string
  description?: string
  iconUrl?: string
  statusColor?: string
}

export interface ApiComponent {
  id: number
  name: string
  description?: string | null
  lead?: { id: number; displayName?: string } | null
}

export interface ApiVersion {
  id: number
  name: string
  description?: string | null
  startDate?: string | null
  releaseDate?: string | null
  archived?: boolean
}

export interface ApiIssue {
  id: number
  key: string
  self: string
  fields: {
    summary: string
    description?: string
    issuetype: ApiIssueType
    status: ApiStatus
    priority: ApiPriority | null
    assignee: ApiUser | null
    reporter: ApiUser
    project: { id: number; key: string; name: string }
    created: string
    updated: string
    duedate: string | null
    startdate?: string | null
    storyPoints?: number | null
    /** Impediment flag. */
    flagged?: boolean
    labels: string[]
    /** Additive colour data for `labels` (name, palette token or #hex, remove-on-resolution flag). */
    labelDetails?: { name: string; color: string | null; removeOnResolve: boolean }[]
    components: { id: number; name: string }[]
    fixVersions: { id: number; name: string }[]
    versions: { id: number; name: string }[]
    votes: { votes: number; hasVoted: boolean }
    resolution: { id: number; name: string } | null
    environment?: string | null
    /** Issue security level (null when the issue has none). */
    security?: { id: number; name: string; description?: string | null } | null
    timeestimate: number | null
    timespent: number | null
    parent: { id: number; key?: string; summary?: string } | null
    sprint?: { id: number; name: string; state?: string | null } | null
    resolved?: string | null
    subtasks: ApiSubtask[]
    issuelinks: ApiIssueLink[]
  }
}

export interface SearchResponse {
  expand: string
  startAt: number
  maxResults: number
  total: number
  issues: ApiIssue[]
}

export interface CommentItem {
  id: string
  self: string
  author: { id: number; displayName?: string; isAgent?: boolean }
  body: string
  internal?: boolean
  /** Id of the comment this one replies to (null for top-level comments). */
  parentId?: string | null
  reactions?: Array<{ emoji: string; count: number; me: boolean }>
  created: string
  updated: string
}

export interface CommentsResponse {
  startAt: number
  maxResults: number
  total: number
  isLast: boolean
  comments: CommentItem[]
}

export interface HistoryItem {
  id: string
  author: { id: number; displayName?: string; isAgent?: boolean }
  created: string
  items: {
    field: string
    fieldtype: string
    fieldId: string
    from?: string
    fromString?: string
    to?: string
    toString?: string
  }[]
}

export interface HistoryResponse {
  startAt: number
  maxResults: number
  total: number
  histories: HistoryItem[]
}

export interface StatusMeta {
  id: string
  name: string
  description: string | null
  statusCategory: { id: number; key: string; colorName: string }
}

/* ------------------------------------------------------------------ */
/*  Issues                                                             */
/* ------------------------------------------------------------------ */

export function useIssues(jql = '', enabled = true) {
  // Issues whose delete is waiting behind an undo toast are hidden right away.
  const pendingDeletes = usePendingDeletes((s) => s.keys)
  const select = useCallback(
    (data: SearchResponse): SearchResponse => {
      if (pendingDeletes.size === 0) return data
      const issues = data.issues.filter((i) => !pendingDeletes.has(i.key))
      return issues.length === data.issues.length ? data : { ...data, issues, total: Math.max(0, data.total - (data.issues.length - issues.length)) }
    },
    [pendingDeletes],
  )
  return useQuery<SearchResponse, Error, SearchResponse>({
    queryKey: ['issues', 'search', jql],
    queryFn: () => fetchJson<SearchResponse>(`/rest/api/2/search?jql=${encodeURIComponent(jql)}`),
    enabled,
    select,
  })
}

export function useIssue(key: string) {
  return useQuery<ApiIssue, Error>({
    queryKey: ['issue', key],
    queryFn: () => fetchJson<ApiIssue>(`/rest/api/2/issue/${encodeURIComponent(key)}`),
    enabled: !!key,
  })
}

export function useIssueComments(key: string) {
  return useQuery<CommentsResponse, Error>({
    queryKey: ['issue', key, 'comments'],
    queryFn: () => fetchJson<CommentsResponse>(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`),
    enabled: !!key,
  })
}

export function useIssueHistory(key: string) {
  return useQuery<HistoryResponse, Error>({
    queryKey: ['issue', key, 'history'],
    queryFn: () => fetchJson<HistoryResponse>(`/rest/api/2/issue/${encodeURIComponent(key)}/changelog`),
    enabled: !!key,
  })
}

export function useSubtasks(key: string) {
  return useQuery<SearchResponse, Error>({
    queryKey: ['issues', 'search', `parent=${key}`],
    queryFn: () => fetchJson<SearchResponse>(`/rest/api/2/search?jql=${encodeURIComponent(`parent = ${key}`)}`),
    enabled: !!key,
  })
}

/* ------------------------------------------------------------------ */
/*  Transitions                                                        */
/* ------------------------------------------------------------------ */

export function useIssueTransitions(key: string) {
  return useQuery<{ transitions: ApiTransition[] }, Error>({
    queryKey: ['issue', key, 'transitions'],
    queryFn: () => fetchJson(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`),
    enabled: !!key,
  })
}

export function useTransitionIssue() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      key,
      transitionId,
      fields,
    }: {
      key: string
      transitionId: number
      fields?: Record<string, any>
    }) =>
      fetchJson(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transition: { id: transitionId }, fields }),
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key] })
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key, 'transitions'] })
      queryClient.invalidateQueries({ queryKey: ['issues', 'search'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Watchers                                                           */
/* ------------------------------------------------------------------ */

export function useIssueWatchers(key: string) {
  return useQuery<ApiWatcherData, Error>({
    queryKey: ['issue', key, 'watchers'],
    queryFn: () => fetchJson(`/rest/api/2/issue/${encodeURIComponent(key)}/watchers`),
    enabled: !!key,
  })
}

export function useToggleWatch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ key, watching }: { key: string; watching: boolean }) => {
      const url = `/rest/api/2/issue/${encodeURIComponent(key)}/watchers`
      if (watching) {
        return fetchJson(url, { method: 'POST' })
      } else {
        return fetchJson(url, { method: 'DELETE' })
      }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key, 'watchers'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Votes                                                              */
/* ------------------------------------------------------------------ */

export function useIssueVotes(key: string) {
  return useQuery<ApiVoteData, Error>({
    queryKey: ['issue', key, 'votes'],
    queryFn: () => fetchJson(`/rest/api/2/issue/${encodeURIComponent(key)}/votes`),
    enabled: !!key,
  })
}

export function useToggleVote() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ key, voting }: { key: string; voting: boolean }) => {
      const url = `/rest/api/2/issue/${encodeURIComponent(key)}/votes`
      if (voting) {
        return fetchJson(url, { method: 'POST' })
      } else {
        return fetchJson(url, { method: 'DELETE' })
      }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key, 'votes'] })
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Attachments                                                        */
/* ------------------------------------------------------------------ */

export function useIssueAttachments(key: string) {
  return useQuery<ApiAttachment[], Error>({
    queryKey: ['issue', key, 'attachments'],
    queryFn: () => fetchJson(`/rest/api/2/issue/${encodeURIComponent(key)}/attachments`),
    enabled: !!key,
  })
}

export function useAddAttachment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, files }: { key: string; files: FileList | File[] }) => {
      const formData = new FormData()
      for (let i = 0; i < files.length; i++) {
        formData.append('file', files[i])
      }
      return fetchJson<ApiAttachment[]>(`/rest/api/2/issue/${encodeURIComponent(key)}/attachments`, {
        method: 'POST',
        body: formData,
      })
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key, 'attachments'] })
    },
  })
}

export function useDeleteAttachment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, id }: { key: string; id: string }) =>
      fetchJson(`/rest/api/2/attachment/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key, 'attachments'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Comments                                                           */
/* ------------------------------------------------------------------ */

export function useAddComment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, body, internal, parentId }: { key: string; body: string; internal?: boolean; parentId?: string }) =>
      fetchJson<CommentItem>(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, ...(internal ? { internal: true } : {}), ...(parentId ? { parentId: Number(parentId) } : {}) }),
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key, 'comments'] })
    },
  })
}

export function useUpdateComment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, commentId, body }: { key: string; commentId: string; body: string }) =>
      fetchJson(`/rest/api/2/issue/${encodeURIComponent(key)}/comment/${commentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key, 'comments'] })
    },
  })
}

export function useToggleReaction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, commentId, emoji }: { key: string; commentId: string; emoji: string }) =>
      fetchJson(`/rest/api/2/issue/${encodeURIComponent(key)}/comment/${commentId}/reaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key, 'comments'] })
    },
  })
}

export function useDeleteComment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, commentId }: { key: string; commentId: string }) =>
      fetchJson(`/rest/api/2/issue/${encodeURIComponent(key)}/comment/${commentId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key, 'comments'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Statuses                                                           */
/* ------------------------------------------------------------------ */

export function useResolutions() {
  return useQuery<ApiResolution[], Error>({
    queryKey: ['resolutions'],
    queryFn: () => fetchJson<ApiResolution[]>('/rest/api/2/resolution'),
    staleTime: 5 * 60_000,
  })
}

export function useLinkTypes() {
  return useQuery<{ issueLinkTypes: ApiLinkType[] }, Error>({
    queryKey: ['issueLinkTypes'],
    queryFn: () => fetchJson('/rest/api/2/issueLinkType'),
    staleTime: 5 * 60_000,
  })
}

export function useIssueTypesMeta() {
  return useQuery<ApiIssueTypeMeta[], Error>({
    queryKey: ['issuetypes'],
    queryFn: () => fetchJson<ApiIssueTypeMeta[]>('/rest/api/2/issuetype'),
    staleTime: 5 * 60_000,
  })
}

export function useProjectsList(enabled = true) {
  return useQuery<ApiProjectSummary[], Error>({
    queryKey: ['projects', 'list'],
    queryFn: () => fetchJson<ApiProjectSummary[]>('/rest/api/2/project'),
    enabled,
    staleTime: 60_000,
  })
}

export function useStatuses() {
  return useQuery<StatusMeta[], Error>({
    queryKey: ['statuses'],
    queryFn: () => fetchJson<StatusMeta[]>('/rest/api/2/status'),
  })
}

/* ------------------------------------------------------------------ */
/*  Metadata                                                           */
/* ------------------------------------------------------------------ */

export function usePriorities() {
  return useQuery<ApiPriorityMeta[], Error>({
    queryKey: ['priorities'],
    queryFn: () => fetchJson<ApiPriorityMeta[]>('/rest/api/2/priority'),
  })
}

export function useProjectComponents(projectKey: string) {
  return useQuery<ApiComponent[], Error>({
    queryKey: ['project', projectKey, 'components'],
    queryFn: () => fetchJson<ApiComponent[]>(`/rest/api/2/project/${encodeURIComponent(projectKey)}/components`),
    enabled: !!projectKey,
  })
}

export function useProjectVersions(projectKey: string) {
  return useQuery<ApiVersion[], Error>({
    queryKey: ['project', projectKey, 'versions'],
    queryFn: () => fetchJson<ApiVersion[]>(`/rest/api/2/project/${encodeURIComponent(projectKey)}/versions`),
    enabled: !!projectKey,
  })
}

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */

export function useUserSearch(query: string) {
  return useQuery<ApiUserSearchResult[], Error>({
    queryKey: ['users', 'search', query],
    queryFn: () => fetchJson<ApiUserSearchResult[]>(`/rest/api/2/user/search?query=${encodeURIComponent(query)}`),
    enabled: query.length > 0,
  })
}

export function useMyself() {
  return useQuery<ApiUserSearchResult, Error>({
    queryKey: ['myself'],
    queryFn: () => fetchJson('/rest/api/2/myself'),
  })
}

export function useUpdateMyself() {
  const queryClient = useQueryClient()
  return useMutation<ApiUserSearchResult, Error, { displayName?: string; timeZone?: string }>({
    mutationFn: (data) =>
      fetchJson('/rest/api/2/myself', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myself'] })
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Issue Links                                                        */
/* ------------------------------------------------------------------ */

export function useLinkIssues() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      inwardIssue,
      outwardIssue,
      typeId,
    }: {
      inwardIssue: { id: number }
      outwardIssue: { id: number }
      typeId: number
    }) =>
      fetchJson('/rest/api/2/issueLink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inwardIssue, outwardIssue, type: { id: typeId } }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue'] })
    },
  })
}

export function useUnlinkIssue() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ linkId }: { linkId: number }) =>
      fetchJson(`/rest/api/2/issueLink/${linkId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export interface OptimisticLookup {
  users?: Array<{ id: number; displayName: string }>
  priorities?: Array<{ id: number | string; name: string; color?: string }>
  components?: Array<{ id: number; name: string }>
  versions?: Array<{ id: number; name: string }>
}

export function useUpdateIssue() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      key,
      fields,
      expect,
    }: {
      key: string
      fields: Record<string, any>
      /** Display data so reference fields can be shown immediately (optimistic update). */
      lookup?: OptimisticLookup
      /** The summary/description the edit started from: a different current value makes the save fail with a conflict. */
      expect?: { summary?: string | null; description?: string | null }
    }) =>
      fetchJson<ApiIssue>(`/rest/api/2/issue/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, ...(expect ? { expect } : {}) }),
      }),
    onMutate: async (variables) => {
      const queryKey = ['issue', variables.key]
      await queryClient.cancelQueries({ queryKey, exact: true })
      const previous = queryClient.getQueryData<ApiIssue>(queryKey)
      if (previous) {
        queryClient.setQueryData<ApiIssue>(queryKey, patchIssueFields(previous, variables.fields, variables.lookup))
      }
      return { previous }
    },
    onError: (_err, variables, context) => {
      if (context?.previous) queryClient.setQueryData(['issue', variables.key], context.previous)
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: ['issue', variables.key] })
      queryClient.invalidateQueries({ queryKey: ['issues', 'search'] })
    },
  })
}

export function useDeleteIssue() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (key: string) =>
      fetchJson<void>(`/rest/api/2/issue/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues', 'search'] })
    },
  })
}

export function useCreateIssue() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { fields: Record<string, any> }) =>
      fetchJson<{ id: number; key: string; self: string }>('/rest/api/2/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues', 'search'] })
    },
  })
}

export function useCloneIssue() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, data }: { key: string; data?: { projectId?: number; issueTypeId?: number; summary?: string; assigneeId?: number | null } }) =>
      fetchJson<ApiIssue>(`/rest/api/2/issue/${encodeURIComponent(key)}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data || {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issues', 'search'] })
    },
  })
}

export function useMoveIssue() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, data }: { key: string; data: { projectId: number; issueTypeId?: number; statusId?: number } }) =>
      fetchJson<ApiIssue>(`/rest/api/2/issue/${encodeURIComponent(key)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['issue', vars.key] })
      queryClient.invalidateQueries({ queryKey: ['issues', 'search'] })
    },
  })
}
