import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StatusUpdate, UpdateState } from '@/lib/status-updates'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
    throw new Error(msg)
  }
  return res.json()
}

/** History of one project (`scope` = project key) or one epic (`scope` = issue key with `epic`). */
function updatesUrl(scope: string, epic: boolean, initiative: boolean) {
  if (initiative) return `/rest/api/2/initiatives/${encodeURIComponent(scope)}/status-updates`
  return epic ? `/rest/api/2/issue/${encodeURIComponent(scope)}/status-updates` : `/rest/api/2/project/${encodeURIComponent(scope)}/status-updates`
}

/** `initiative`: `scope` is the initiative id (the same panel serves the initiative's health). */
export function useStatusUpdates(scope: string, epic = false, enabled = true, initiative = false) {
  const url = updatesUrl(scope, epic, initiative)
  return useQuery({ queryKey: ['status-updates', initiative ? 'initiative' : epic ? 'epic' : 'project', scope], enabled: enabled && !!scope, queryFn: () => api<{ updates: StatusUpdate[]; latest: StatusUpdate | null }>(url) })
}

export function usePostStatusUpdate(scope: string, epic = false, initiative = false) {
  const qc = useQueryClient()
  const url = updatesUrl(scope, epic, initiative)
  return useMutation({
    mutationFn: (v: { state: UpdateState; body: string }) => api<StatusUpdate>(url, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['status-updates'] })
    },
  })
}

/** Current state of every browsable project, by project key (projects list badges). */
export function useLatestStatusUpdates(enabled = true) {
  return useQuery({
    queryKey: ['status-updates', 'latest'], enabled, staleTime: 30_000,
    queryFn: () => api<{ latest: Record<string, StatusUpdate> }>('/rest/api/2/status-updates/latest').then((r) => r.latest),
  })
}
